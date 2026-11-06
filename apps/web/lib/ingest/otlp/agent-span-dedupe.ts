import { type AgentSpanDedupe, isAgentWrapper, isAnchor, modelCallTraceIds } from "./group";
import type { DecodedSpan } from "./types";

/**
 * Decide, for one ingest batch, which traces already hold a model call, so an
 * agent wrapper span with the run's summed usage is not counted as one more
 * call (see `isDedupedAgentSpan`).
 *
 * The batch alone is not enough: BatchSpanProcessor often exports the child
 * `chat` spans in an earlier request than their root (children end first), so
 * a root that arrives alone asks storage. Known gap: a root stored BEFORE its
 * children keeps counting (follow-up).
 */

/** The subset of `traceIds` that already has a stored model-call span. */
export type FindTracesWithModelCalls = (
  projectId: string,
  traceIds: string[],
) => Promise<Set<string>>;

export interface AgentSpanDedupeDeps {
  findTracesWithModelCalls: FindTracesWithModelCalls;
}

/** The batch's dedupe, or undefined when no storage lookup is wired (a test or a caller that does not dedupe). */
export async function resolveAgentSpanDedupe(
  spans: DecodedSpan[],
  projectId: string,
  deps: AgentSpanDedupeDeps | undefined,
  onLookupFailure: (err: unknown, traceIds: string[]) => void,
): Promise<AgentSpanDedupe | undefined> {
  if (!deps) return undefined;

  const modelCallTraces = modelCallTraceIds(spans);
  // Only a wrapper that would otherwise count (it reports a model or usage) needs storage.
  const unresolved = [
    ...new Set(
      spans
        .filter((s) => isAgentWrapper(s) && isAnchor(s) && !modelCallTraces.has(s.traceId))
        .map((s) => s.traceId),
    ),
  ];
  if (unresolved.length === 0) return { modelCallTraces };

  try {
    for (const traceId of await deps.findTracesWithModelCalls(projectId, unresolved)) {
      modelCallTraces.add(traceId);
    }
  } catch (err) {
    onLookupFailure(err, unresolved);
    // Fail safe toward never double counting: treat the traces as having model
    // calls. Agent-span-only emitters lose this one run's tokens (still in the
    // span's `attributes`); the alternative inflates every child-bearing run.
    for (const traceId of unresolved) modelCallTraces.add(traceId);
  }
  return { modelCallTraces };
}
