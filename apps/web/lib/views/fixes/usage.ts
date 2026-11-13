import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { costFor } from "@/lib/ingest/pricing";
import { traceTurns } from "@/lib/ledger/schema";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import {
  assignModelCalls,
  type LinkCandidate,
} from "@/lib/readings/trace-signals/signals/linked-runs";
import {
  loadLinkCandidates,
  loadRunTraces,
  MAX_LINK_ROWS,
} from "@/lib/readings/trace-signals/signals/linked-runs-query";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { FixUsage } from "@/lib/views/fixes/types";

const MAX_USAGE_RUNS = 20_000;

/**
 * Task usage as the signal job stored it with each task's reading (RC-211),
 * so Fixes, Overview and Agent health do not link every model call in the
 * window to its run on each page view. Null when any task's reading predates
 * the stored totals: the caller then reads it live with `loadTaskUsage`.
 */
export function storedTaskUsage(
  workflows: Pick<StoredWorkflows, "items"> | null | undefined,
  window: { windowStart: Date; windowEnd: Date },
): Map<string, FixUsage> | null {
  const items = workflows?.items ?? [];
  if (items.length === 0) return null;
  const windowDays = (window.windowEnd.getTime() - window.windowStart.getTime()) / 86_400_000;
  const usage = new Map<string, FixUsage>();
  for (const item of items) {
    const totals = item.reading?.version === 1 ? item.reading.usage : undefined;
    if (!totals) return null;
    if (item.reading?.runs === 0) continue;
    usage.set(item.id, { tokens: totals.tokens, usd: null, ms: totals.waitMs, windowDays });
  }
  return usage;
}

/** Task usage over the signal window, with the same model-call attribution as task health. */
export async function loadTaskUsage(
  projectId: string,
  window: { windowStart: Date; windowEnd: Date },
  db: BoundReadDb,
): Promise<Map<string, FixUsage>> {
  // Include runs without a task so their model calls cannot join a different run.
  const runs = await db
    .select({
      id: traceTurns.id,
      taskId: traceTurns.workflowId,
      sessionId: traceTurns.sessionId,
      lane: sql<"runtime">`'runtime'`,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        eq(traceTurns.lane, "runtime"),
        gte(traceTurns.endedAt, window.windowStart),
        lt(traceTurns.endedAt, window.windowEnd),
      ),
    )
    .orderBy(asc(traceTurns.endedAt), asc(traceTurns.id))
    .limit(MAX_USAGE_RUNS + 1);
  if (runs.length > MAX_USAGE_RUNS) throw new Error("task usage exceeds the run limit");
  if (!runs.some((run) => run.taskId !== null)) return new Map();
  const traces = await loadRunTraces(
    projectId,
    runs.map((run) => run.id),
    db,
  );
  const calls = await loadLinkCandidates(
    projectId,
    runs,
    db,
    MAX_LINK_ROWS,
    [...traces.values()].flatMap((ids) => [...ids]),
  );
  if (calls.length >= MAX_LINK_ROWS) throw new Error("task usage exceeds the model call limit");
  const assigned = assignModelCalls(runs, calls, traces);
  const usage = new Map<string, FixUsage>();
  for (const run of runs) {
    if (!run.taskId) continue;
    const linked = assigned.get(run.id) ?? [];
    const total = usage.get(run.taskId) ?? {
      tokens: null,
      usd: null,
      ms: null,
      windowDays: (window.windowEnd.getTime() - window.windowStart.getTime()) / 86_400_000,
    };
    for (const call of linked) {
      if (call.inputTokens === null && call.outputTokens === null) continue;
      total.tokens = (total.tokens ?? 0) + (call.inputTokens ?? 0) + (call.outputTokens ?? 0);
      const usd = costFor(call.model, {
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
      });
      if (usd !== null) total.usd = (total.usd ?? 0) + usd;
    }
    total.ms = (total.ms ?? 0) + runWaitingMs(run, linked);
    usage.set(run.taskId, total);
  }
  return usage;
}

function runWaitingMs(
  run: { startedAt: Date; endedAt: Date },
  calls: readonly LinkCandidate[],
): number {
  const start = Math.min(run.startedAt.getTime(), ...calls.map((call) => call.atMs));
  const end = Math.max(
    run.endedAt.getTime(),
    ...calls.map((call) => call.atMs + Math.max(0, call.tookMs ?? 0)),
  );
  return Math.max(0, end - start);
}
