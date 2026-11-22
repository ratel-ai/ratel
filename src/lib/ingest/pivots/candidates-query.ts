import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { RootSample } from "./candidates";

/**
 * The sample the pivot candidates rank (RC-882): the project's most recent
 * root spans inside a short window. One statement on the partial index
 * `otel_spans_project_roots_started_idx` (project_id, started_at where
 * parent_span_id is null), with a hard row limit: never a scan of the table.
 */

export const SAMPLE_LIMIT = 2000;
export const SAMPLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** No caller may read more than this, whatever it asks. */
const MAX_SAMPLE_LIMIT = 5000;

export type SampleDb = Pick<ReturnType<typeof getDb>, "execute">;

export async function sampleRootSpans(
  projectId: string,
  db: SampleDb,
  options: { now?: Date; limit?: number; windowMs?: number } = {},
): Promise<RootSample[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.windowMs ?? SAMPLE_WINDOW_MS)).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? SAMPLE_LIMIT, MAX_SAMPLE_LIMIT));
  const result = await db.execute<{
    trace_id: string;
    attributes: Record<string, unknown> | null;
  }>(sql`
    select trace_id, attributes from otel_spans
    where project_id = ${projectId} and parent_span_id is null
      and started_at >= ${since} and started_at <= ${now.toISOString()}
    order by started_at desc
    limit ${limit}
  `);
  return result.rows.map((row) => ({ traceId: row.trace_id, attributes: row.attributes ?? {} }));
}
