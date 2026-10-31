import { MIN_USER_ASKS } from "@/lib/readings/trace-signals/workflows/decide";
import { MIN_EXACT_RUNS } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * A reading made on incomplete data waits for the fix: turn ids for runs mixed
 * together (or never sent), tool calls for a page without any, users' messages
 * for requests read from searches. Once enough fixed data has arrived since the
 * reading, the turn builder asks for a new one right away instead of at the
 * next daily sweep, and that run reads the fixed runs (`run-basis.ts`,
 * `preferUserAsks`).
 *
 * Pure: the stored summary in, what it waits for out. Untrusted JSON is read
 * defensively.
 */

export type AwaitedFix = "turn_ids" | "tool_calls" | "user_messages";

/** Fixed rows each fix needs before a new reading is worth it. */
export const FIX_ENOUGH: Readonly<Record<AwaitedFix, number>> = {
  turn_ids: MIN_EXACT_RUNS,
  tool_calls: MIN_EXACT_RUNS,
  user_messages: MIN_USER_ASKS,
};

/** How long after a reading a fix may ask for the next one; longer after a fix already asked once. */
export const FIX_RERUN_AFTER_MS = 30 * 60_000;
export const FIX_RERUN_AGAIN_AFTER_MS = 6 * 3_600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

function factStatus(setup: unknown, key: string): string | null {
  if (!isRecord(setup) || !Array.isArray(setup.facts)) return null;
  const fact = setup.facts.find((f) => isRecord(f) && f.key === key);
  return isRecord(fact) && typeof fact.status === "string" ? fact.status : null;
}

/** What a stored reading waits for, from its summary. */
export function awaitedFixes(summary: unknown): AwaitedFix[] {
  if (!isRecord(summary)) return [];
  const basis =
    isRecord(summary.workflows) && isRecord(summary.workflows.basis)
      ? summary.workflows.basis
      : null;
  const out: AwaitedFix[] = [];
  if (basis?.blocked === "no_tool_calls") out.push("tool_calls");
  if (basis?.blocked === "mixed_runs" || factStatus(summary.setup, "sdk_turn_ids") === "off")
    out.push("turn_ids");
  if (factStatus(summary.setup, "sdk_user_messages") === "off") out.push("user_messages");
  return out;
}

/** Whether enough time passed since the reading for a fix to ask for another. */
export function fixRerunDue(
  latest: { finishedAt: Date | null; trigger: string },
  now: Date,
): boolean {
  if (!latest.finishedAt) return false;
  const wait = latest.trigger === "data_fixed" ? FIX_RERUN_AGAIN_AFTER_MS : FIX_RERUN_AFTER_MS;
  return now.getTime() - latest.finishedAt.getTime() >= wait;
}

/** The first fix with enough fixed rows since the reading, or null. */
export function arrivedFix(
  awaited: readonly AwaitedFix[],
  countSince: Readonly<Partial<Record<AwaitedFix, number>>>,
): AwaitedFix | null {
  return awaited.find((fix) => (countSince[fix] ?? 0) >= FIX_ENOUGH[fix]) ?? null;
}
