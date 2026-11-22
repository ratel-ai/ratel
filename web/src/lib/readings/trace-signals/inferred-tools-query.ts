import { sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { WindowDays } from "@/lib/readings/trace-signals/view";

/**
 * How many of the window's tool calls were inferred from span shape
 * (`ratel.tool.inferred`, set by an importer that infers them) rather than recorded
 * as tool calls. One statement over the `(project_id, started_at)` index.
 */

export type InferredToolsDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface InferredToolShare {
  /** Tool spans (`execute_tool`) that started in the window. */
  toolSpans: number;
  /** Those marked inferred. */
  inferred: number;
}

const DAY_MS = 24 * 60 * 60_000;

export async function loadInferredToolShare(
  projectId: string,
  options: { now: Date; windowDays: WindowDays },
  db: InferredToolsDb = getDb(),
): Promise<InferredToolShare> {
  const since = new Date(options.now.getTime() - options.windowDays * DAY_MS).toISOString();
  const result = await db.execute(sql`
    select count(*)::int as tool_spans,
      count(*) filter (where attributes->>'ratel.tool.inferred' = 'true')::int as inferred
    from otel_spans
    where project_id = ${projectId} and started_at >= ${since} and operation_name = 'execute_tool'`);
  const row = result.rows[0] as { tool_spans?: unknown; inferred?: unknown } | undefined;
  return { toolSpans: Number(row?.tool_spans ?? 0), inferred: Number(row?.inferred ?? 0) };
}

/** The reading's tool calls are mostly inferred: the page says so. */
export function toolCallsInferred(share: InferredToolShare | null): boolean {
  return share !== null && share.inferred > 0 && share.inferred * 2 >= share.toolSpans;
}
