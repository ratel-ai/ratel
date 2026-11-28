import { sql } from "drizzle-orm";
import type { GeographyQuery } from "@/lib/contracts/query";
import { addressResolution } from "@/lib/ingest/geo/address";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, measureBy, rowsOf } from "@/lib/synthesis/metrics/query";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import { type TraceFilter, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";

/** A measure by country, or by region of one country. */

export interface GeographyPlace {
  /** "US", or "US-CA". */
  code: string;
  value: number | null;
  /** Traces, or scorer results, behind the value. */
  samples: number;
}

export interface GeographyResult {
  kind: "geography";
  /** The highest value first. */
  places: GeographyPlace[];
  /** How many of the matching traces have a place to be shown at. */
  located: { traces: number; matched: number };
  /** Whether the deployment resolves IP addresses. */
  resolvesAddresses: boolean;
}

/** More than there are countries, or regions of one. */
const PLACE_LIMIT = 400;

export async function runGeography(
  projectId: string,
  { measures, filters, country }: GeographyQuery,
  scope: QueryScope,
  db: MetricsDb,
  resolves: () => Promise<boolean> = addressResolution,
): Promise<GeographyResult> {
  const column = country ? sql`s.geo_region` : sql`s.geo_country`;
  const where = country ? sql`s.geo_country = ${country}` : sql`s.geo_country is not null`;
  const places = await measureBy(
    projectId,
    { measures, filters },
    { group: { column, array: false }, where, limit: PLACE_LIMIT },
    scope,
    db,
  );
  const { scorer: _, ...own } = filters;
  const condition = traceFilterCondition(projectId, withClause<TraceFilter>(own, scope.filter));
  const [count] = rowsOf<{ matched: number | string; located: number | string }>(
    await db.execute(sql`
      select count(*)::int as matched, count(${column})::int as located
      from otel_trace_summaries s
      where s.project_id = ${projectId}
        and s.started_at >= ${scope.since.toISOString()}::timestamptz
        and s.started_at < ${scope.until.toISOString()}::timestamptz
        ${country ? sql`and s.geo_country = ${country}` : sql``}
        ${condition ? sql`and ${condition}` : sql``}`),
  );
  return {
    kind: "geography",
    places: places.map(({ group, value, samples }) => ({ code: group, value, samples })),
    located: { traces: Number(count?.located ?? 0), matched: Number(count?.matched ?? 0) },
    resolvesAddresses: await resolves(),
  };
}
