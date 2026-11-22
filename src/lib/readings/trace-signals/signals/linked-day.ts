import type { LinkedRunFact } from "@/lib/readings/trace-signals/signals/linked-runs";

/**
 * One day's SDK runs linked to OpenTelemetry model calls (`linked-runs.ts`),
 * kept beside a day's SDK counts (`DayBucket.linked`) and only on days that
 * had such a run, so every other project's stored buckets stay exactly as
 * they were. Counts and dollars only; no ids, no text.
 */

export interface LinkedDay {
  /** SDK runs linked to at least one model call. */
  runs: number;
  modelCalls: number;
  /** Linked runs whose model has a known price, and their summed cost in USD. */
  pricedRuns: number;
  costUsd: number;
  /** Summed model-call durations, ms. Absent on buckets stored before it was kept. */
  modelMs?: number;
  /** Summed tokens over the calls. Absent on buckets stored before they were kept. */
  inputTokens?: number;
  outputTokens?: number;
}

const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function linkedDayOf(
  fact: Pick<LinkedRunFact, "modelCalls" | "costUsd" | "modelMs" | "inputTokens" | "outputTokens">,
): LinkedDay {
  return {
    runs: 1,
    modelCalls: fact.modelCalls,
    pricedRuns: fact.costUsd === null ? 0 : 1,
    costUsd: fact.costUsd ?? 0,
    modelMs: fact.modelMs,
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
  };
}

export function addLinkedDays(
  left: LinkedDay | undefined,
  right: LinkedDay | undefined,
): LinkedDay | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  return {
    runs: left.runs + right.runs,
    modelCalls: left.modelCalls + right.modelCalls,
    pricedRuns: left.pricedRuns + right.pricedRuns,
    costUsd: roundUsd(left.costUsd + right.costUsd),
    modelMs: (left.modelMs ?? 0) + (right.modelMs ?? 0),
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
  };
}
