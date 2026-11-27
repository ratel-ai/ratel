import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { TRACE_FILTER_FACET_LIMIT } from "@/lib/synthesis/traces/trace-filters";

/**
 * The values a filter of a trace property offers (RTL-396): for each name asked, its most frequent
 * values on the project's trace summaries in the window, `TRACE_FILTER_FACET_LIMIT` (50) at most.
 * One bounded query for every name, as the facets of the other filters are.
 */

export type PropertyFacetsDb = Pick<ReturnType<typeof getDb>, "execute">;

/** Each name with its values, most traces first; a name with no value in the window has none. */
export async function getPropertyFacets(
  projectId: string,
  names: readonly string[],
  window: { since: Date; until?: Date },
  db: PropertyFacetsDb,
  limit = TRACE_FILTER_FACET_LIMIT,
): Promise<Record<string, TraceFacetValue[]>> {
  const facets: Record<string, TraceFacetValue[]> = Object.fromEntries(
    names.map((name) => [name, []]),
  );
  if (names.length === 0) return facets;
  const result = await db.execute(sql`
    with w as (
      select s.properties from otel_trace_summaries s
      where s.project_id = ${projectId}::uuid
        and s.started_at >= ${window.since.toISOString()}::timestamptz
        ${window.until ? sql`and s.started_at < ${window.until.toISOString()}::timestamptz` : sql``}
        and s.properties <> '{}'::jsonb
    ),
    counted as (
      select e.key as name, e.value, count(*)::int as count
      from w, jsonb_each_text(w.properties) e
      where e.key = any(array[${sql.join(
        names.map((name) => sql`${name}`),
        sql`, `,
      )}]::text[])
      group by e.key, e.value
    ),
    ranked as (
      select name, value, count,
        row_number() over (partition by name order by count desc, value collate "C") as rank
      from counted
    )
    select name, value, count from ranked where rank <= ${limit} order by name, rank`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as {
    name: string;
    value: string;
    count: number | string;
  }[];
  for (const row of rows) facets[row.name]?.push({ value: row.value, count: Number(row.count) });
  return facets;
}
