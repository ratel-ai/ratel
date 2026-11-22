/**
 * Replay of recorded items (RC-1103, spec §4 and §9): a production item call
 * stamped with `ratel.sandbox.input` opens in its sandbox, and Compare runs the code
 * defaults (baseline) and the edits (candidate) over up to 50 of them, as a
 * loop over single runs. Pure rules only, shared by the API and the browser.
 */

export type ReplayArm = "baseline" | "candidate";

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
}

/** One arm of one compared item, as the browser tracks it. */
export interface CompareArm {
  /** queued, running, then the run's end status (ok, error, canceled, lost …). */
  status: string;
  output: unknown;
  metrics: RunMetrics | null;
}

export interface CompareRow {
  baseline: CompareArm;
  candidate: CompareArm;
}

export interface ArmTotals {
  runs: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface CompareSummary {
  baseline: ArmTotals;
  candidate: ArmTotals;
  /** Items where both arms ended ok. */
  compared: number;
  /** Of those, the items whose outputs differ. */
  changed: number;
}

export interface OutputChange {
  /** The top-level key that changed; empty when the whole value is compared. */
  path: string;
  baseline: unknown;
  candidate: unknown;
}

/** Compare runs at most this many recorded items. The API refuses more. */
export const MAX_COMPARE_ITEMS = 50;

const SANDBOX_ID = "ratel.sandbox.id";
const SANDBOX_INPUT = "ratel.sandbox.input";
const ENVIRONMENT = "deployment.environment.name";
const LABEL_MAX = 50;
const FAILED_STATUSES = new Set(["error", "canceled", "rejected", "lost", "unknown"]);

/** The sandbox page with this span's item open, or null when the span is not a recorded production item. */
export function openInSandboxHref(
  projectId: string,
  spanId: string,
  attributes: Readonly<Record<string, unknown>>,
): string | null {
  const sandboxId = attributes[SANDBOX_ID];
  if (typeof sandboxId !== "string" || !sandboxId || !(SANDBOX_INPUT in attributes)) return null;
  if (attributes[ENVIRONMENT] === "playground") return null;
  return `/project/${encodeURIComponent(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}?span=${encodeURIComponent(spanId)}`;
}

/** A short name for a recorded item: its first text field, else its span. */
export function itemLabel(input: unknown, spanId: string): string {
  const first = isPlainObject(input)
    ? Object.values(input).find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      )
    : undefined;
  if (!first) return `Item ${spanId.slice(0, 8)}`;
  return first.length > LABEL_MAX ? `${first.slice(0, LABEL_MAX - 3)}…` : first;
}

/** Why a compare selection is refused, or null when it may run. */
export function checkCompareSelection(spanIds: readonly string[]): string | null {
  if (spanIds.length < 1) return "Pick at least 1 recorded item.";
  if (spanIds.length > MAX_COMPARE_ITEMS)
    return `Compare takes at most ${MAX_COMPARE_ITEMS} items.`;
  if (new Set(spanIds).size !== spanIds.length) return "Pick each item once.";
  return null;
}

/** The arm a replay run is: the code defaults are the baseline, any edit makes the candidate. */
export function replayArm(changed: readonly string[]): ReplayArm {
  return changed.length === 0 ? "baseline" : "candidate";
}

/** The output diff of one item: the changed top-level keys of two objects, else the two whole values. */
export function outputDiff(
  baseline: unknown,
  candidate: unknown,
): { same: boolean; changes: OutputChange[] } {
  if (isPlainObject(baseline) && isPlainObject(candidate)) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])];
    const changes = keys
      .filter((key) => canonical(baseline[key]) !== canonical(candidate[key]))
      .map((key) => ({ path: key, baseline: baseline[key], candidate: candidate[key] }));
    return { same: changes.length === 0, changes };
  }
  const same = canonical(baseline) === canonical(candidate);
  return { same, changes: same ? [] : [{ path: "", baseline, candidate }] };
}

/** The summary row: per arm, the finished runs' tokens, cost and latency; and how many outputs changed. */
export function compareSummary(rows: readonly CompareRow[]): CompareSummary {
  const baseline = totals(rows.map((r) => r.baseline));
  const candidate = totals(rows.map((r) => r.candidate));
  const both = rows.filter((r) => r.baseline.status === "ok" && r.candidate.status === "ok");
  return {
    baseline,
    candidate,
    compared: both.length,
    changed: both.filter((r) => !outputDiff(r.baseline.output, r.candidate.output).same).length,
  };
}

/**
 * Runs the tasks with at most `limit` at once (the runner's concurrency),
 * starting them in order. Resolves with every result, in task order.
 */
export async function runPool<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return results;
}

function totals(arms: readonly CompareArm[]): ArmTotals {
  const result: ArmTotals = {
    runs: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  for (const arm of arms) {
    if (FAILED_STATUSES.has(arm.status)) result.failed += 1;
    if (arm.status !== "ok") continue;
    result.runs += 1;
    if (!arm.metrics) continue;
    result.inputTokens += arm.metrics.inputTokens;
    result.outputTokens += arm.metrics.outputTokens;
    result.costUsd = round6(result.costUsd + arm.metrics.costUsd);
    result.latencyMs += arm.metrics.latencyMs ?? 0;
  }
  return result;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so key order never reads as a change. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}
