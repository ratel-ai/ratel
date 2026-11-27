import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";

/**
 * The erase of one trace property's stored values (RTL-395): the key comes out of every span and
 * trace summary of the project, in bounded batches. The key name stays in `trace_property_keys`
 * as detected, and no other project is read or written.
 */

export type PropertyValuesDb = Pick<ReturnType<typeof getDb>, "execute">;

export const ERASE_BATCH_SIZE = 5_000;

export async function erasePropertyValues(
  db: PropertyValuesDb,
  projectId: string,
  name: string,
  batchSize = ERASE_BATCH_SIZE,
): Promise<{ spans: number; traces: number }> {
  let spans = 0;
  for (;;) {
    const erased = rowsOf(
      await db.execute(sql`
        with picked as (
          select id from otel_spans
          where project_id = ${projectId}::uuid and properties ? ${name}
          limit ${batchSize})
        update otel_spans s set properties = nullif(s.properties - ${name}::text, '{}'::jsonb)
        from picked where s.id = picked.id
        returning 1`),
    ).length;
    spans += erased;
    if (erased < batchSize) break;
  }
  let traces = 0;
  for (;;) {
    const erased = rowsOf(
      await db.execute(sql`
        with picked as (
          select trace_id from otel_trace_summaries
          where project_id = ${projectId}::uuid and properties ? ${name}
          limit ${batchSize})
        update otel_trace_summaries t set properties = t.properties - ${name}::text
        from picked where t.project_id = ${projectId}::uuid and t.trace_id = picked.trace_id
        returning 1`),
    ).length;
    traces += erased;
    if (erased < batchSize) break;
  }
  return { spans, traces };
}

function rowsOf(result: unknown): unknown[] {
  return (result as { rows: unknown[] }).rows;
}
