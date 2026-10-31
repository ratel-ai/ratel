import { envNumber } from "@/lib/platform/env-number";
import type { StepDraft } from "./types";

/**
 * Retry or next step: whether a search in a turn asks for the same thing as the search
 * before it.
 *
 * A turn often has several needs ("find the Q3 roadmap review", then "change its
 * priority"), each served by its own search. A second search is only a sign of trouble
 * when it looks for the SAME thing again. The ledger keeps no query text, so this is a
 * content-free proxy over what it does keep:
 *
 *   sameAsk(a, b) = identical salted query hash
 *                   OR Jaccard(top-10 hit ids of a, top-10 hit ids of b) >= T
 *
 * T is `TRACE_SIGNALS_SAME_ASK_JACCARD` (default 0.5). It was chosen on a labelled
 * production replay: of its 157 consecutive search pairs, 107 share no top-10 hit at all
 * and only 8 reach 0.5, and those 8 read as reformulations of the same ask; between 0.25
 * and 0.45 the pairs mix retries with new needs, so a lower bar would bring back the
 * false alarms this rule exists to remove.
 *
 * Every Agent health surface that says "searched again" reads these helpers (the turn
 * facts, the first-try and detour tiles, `first_try_miss`, `no_follow_through`, the
 * wasted-calls count), so they cannot disagree.
 */

/** Hit ids compared per search. */
export const SAME_ASK_TOP_HITS = 10;

/** Top-10 hit-id Jaccard at or above which two searches ask for the same thing. */
export const SAME_ASK_MIN_JACCARD = envNumber(
  "TRACE_SIGNALS_SAME_ASK_JACCARD",
  0.5,
  (n) => n > 0 && n <= 1,
);

/** Jaccard of the two searches' top-10 hit ids; null when either lists nothing. */
export function hitOverlap(
  a: Pick<StepDraft, "hitIds">,
  b: Pick<StepDraft, "hitIds">,
): number | null {
  const left = new Set((a.hitIds ?? []).slice(0, SAME_ASK_TOP_HITS));
  const right = new Set((b.hitIds ?? []).slice(0, SAME_ASK_TOP_HITS));
  if (left.size === 0 || right.size === 0) return null;
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Whether two searches ask for the same thing: same query hash, or mostly the same hits. */
export function sameAsk(
  a: Pick<StepDraft, "kind" | "queryHash" | "hitIds">,
  b: Pick<StepDraft, "kind" | "queryHash" | "hitIds">,
  threshold: number = SAME_ASK_MIN_JACCARD,
): boolean {
  if (a.kind !== "search" || b.kind !== "search") return false;
  if (a.queryHash !== null && a.queryHash === b.queryHash) return true;
  const overlap = hitOverlap(a, b);
  return overlap !== null && overlap >= threshold;
}

/** The search step with this ordinal, if the turn has one. */
export function searchAt(
  steps: readonly StepDraft[],
  ordinal: number | null,
): StepDraft | undefined {
  if (ordinal === null) return undefined;
  const step = steps.find((s) => s.ordinal === ordinal);
  return step?.kind === "search" ? step : undefined;
}

/** The last search before `step` in the turn. */
export function searchBefore(
  steps: readonly StepDraft[],
  step: Pick<StepDraft, "ordinal">,
): StepDraft | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const candidate = steps[i];
    if (candidate && candidate.kind === "search" && candidate.ordinal < step.ordinal) {
      return candidate;
    }
  }
  return undefined;
}

/** Whether `search` repeats the ask of the search right before it. */
export function isRetrySearch(
  steps: readonly StepDraft[],
  search: StepDraft,
  threshold: number = SAME_ASK_MIN_JACCARD,
): boolean {
  const previous = searchBefore(steps, search);
  return previous !== undefined && sameAsk(previous, search, threshold);
}

/**
 * The same-ask searches that led up to `search`, oldest first, not including it: walk
 * back while each search repeats the one before. Empty when `search` started a new ask.
 */
export function retryChain(
  steps: readonly StepDraft[],
  search: StepDraft,
  threshold: number = SAME_ASK_MIN_JACCARD,
): StepDraft[] {
  const chain: StepDraft[] = [];
  let current = search;
  for (;;) {
    const previous = searchBefore(steps, current);
    if (!previous || !sameAsk(previous, current, threshold)) return chain.reverse();
    chain.push(previous);
    current = previous;
  }
}

/** Whether a search listed this tool or skill among its hits. */
export function lists(search: Pick<StepDraft, "hitIds">, targetId: string): boolean {
  return (search.hitIds ?? []).includes(targetId);
}

/**
 * The retry that reached an invoked target, or null: the search that offered it repeats
 * the search before it, and that earlier search did not list it. `extraSearches` counts
 * the same-ask searches spent before the one that worked; `listedEarlier` is true when
 * an older search in the chain had it.
 */
export function retryReaching(
  steps: readonly StepDraft[],
  invoke: StepDraft,
  threshold: number = SAME_ASK_MIN_JACCARD,
): { previous: StepDraft; extraSearches: number; listedEarlier: boolean } | null {
  const offering = searchAt(steps, invoke.offeredByOrdinal);
  const targetId = invoke.targetId;
  if (!offering || targetId === null) return null;
  const chain = retryChain(steps, offering, threshold);
  const previous = chain.at(-1);
  if (!previous || lists(previous, targetId)) return null;
  return {
    previous,
    extraSearches: chain.length,
    listedEarlier: chain.slice(0, -1).some((s) => lists(s, targetId)),
  };
}

/**
 * Whether the ok invocation at `index` was followed at once (the next step, within
 * `withinMs` of its end) by a search for the same thing as the search that led to it:
 * the agent kept looking, so the call likely did not deliver.
 */
export function searchedAgainForSame(
  steps: readonly StepDraft[],
  index: number,
  withinMs: number,
  threshold: number = SAME_ASK_MIN_JACCARD,
): boolean {
  const step = steps[index];
  const next = steps[index + 1];
  if (!step || !next || step.kind !== "invoke" || step.targetId === null || step.outcome !== "ok") {
    return false;
  }
  if (next.kind !== "search") return false;
  const endedAt = (step.endOccurredAt ?? step.occurredAt).getTime();
  if (next.occurredAt.getTime() - endedAt > withinMs) return false;
  const led = searchAt(steps, step.offeredByOrdinal);
  return led !== undefined && sameAsk(led, next, threshold);
}

/** The first call of each target in the turn, in order. */
function firstCalls(steps: readonly StepDraft[]): StepDraft[] {
  const seen = new Set<string>();
  return steps.filter((s) => {
    if (s.kind !== "invoke" || s.targetId === null) return false;
    const key = `${s.targetType}:${s.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * First try: every tool the turn ran was offered by the most recent search before its
 * first call, and that search was not a retry of the one before. A two-step turn with a
 * fresh search per need is first try. Null when the turn has no search or no call with
 * a target.
 */
export function turnFirstTry(
  steps: readonly StepDraft[],
  threshold: number = SAME_ASK_MIN_JACCARD,
): boolean | null {
  const calls = firstCalls(steps);
  if (calls.length === 0 || !steps.some((s) => s.kind === "search")) return null;
  return calls.every((call) => {
    const recent = searchBefore(steps, call);
    return (
      recent !== undefined &&
      call.offeredByOrdinal === recent.ordinal &&
      !isRetrySearch(steps, recent, threshold)
    );
  });
}

/**
 * Detour: the turn searched again for the same thing at least once, before or after
 * running something. A later search for a new need is not a detour.
 */
export function turnDetour(
  steps: readonly StepDraft[],
  threshold: number = SAME_ASK_MIN_JACCARD,
): boolean {
  return steps.some((s) => s.kind === "search" && isRetrySearch(steps, s, threshold));
}
