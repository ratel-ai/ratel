import type { FixKind } from "@/lib/views/fixes/kinds";
import { formatSeconds, formatUsd } from "@/lib/views/task-scorers/format";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { outcomeDefaults } from "@/lib/views/task-scorers/outcome";
import { rebaseScorers } from "@/lib/views/task-scorers/replay";
import type { Scorer } from "@/lib/views/task-scorers/types";
import { methodForKind } from "./method";
import {
  type Expected,
  type FixChange,
  type InvokeStep,
  NO_EXPECTATION,
  type RunRecord,
  type RunView,
} from "./types";

export { formatSeconds, formatUsd } from "@/lib/views/task-scorers/format";
export { outcomeDefaults } from "@/lib/views/task-scorers/outcome";

/**
 * A new run's expected outcome, drafted from the run itself and the fix's
 * kind: what "the fix worked" means for this run. A starting point the person
 * edits on the eval page; never re-drafted over their edits. Pure.
 */

const RANKING: ReadonlySet<FixKind> = new Set(["rewrite", "tell-apart", "fewer-results", "retire"]);

function calls(run: RunRecord): InvokeStep[] {
  return run.steps.filter((step): step is InvokeStep => step.kind === "invoke");
}

/** The tool this run wanted: one of the fix's tools it ran, else the first it ran without failing, else the first it ran. */
export function wantedTool(
  run: RunRecord,
  fixTools: readonly string[],
  avoid: readonly string[] = [],
): string | null {
  const ran = calls(run).filter((call) => !avoid.includes(call.targetId));
  const own = ran.find((call) => fixTools.includes(call.targetId) && call.outcome !== "error");
  if (own) return own.targetId;
  return ran.find((call) => call.outcome === "ok")?.targetId ?? ran[0]?.targetId ?? null;
}

/** The fewest calls the run needs once the set is one call: distinct tools, the set counted once. */
export function neededCalls(run: RunRecord, collapse: readonly string[]): number {
  const distinct = new Set(calls(run).map((call) => call.targetId));
  const inSet = [...distinct].filter((id) => collapse.includes(id)).length;
  return Math.max(1, distinct.size - Math.max(0, inSet - 1));
}

export function defaultExpected(
  run: RunRecord,
  kind: FixKind,
  change: FixChange,
  fixTools: readonly string[],
): Expected {
  const expected: Expected = { ...NO_EXPECTATION, avoidTools: [] };
  if (kind === "retire") {
    expected.avoidTools = [...change.hide];
    expected.tool = wantedTool(run, [], change.hide);
    return expected;
  }
  if (RANKING.has(kind) || Object.keys(change.patches).length > 0) {
    // A rewrite wants its own tool found; returning fewer results wants the tool the run used kept.
    const own = Object.keys(change.patches);
    expected.tool =
      wantedTool(run, own.length > 0 ? own : fixTools) ?? own[0] ?? fixTools[0] ?? null;
  }
  // A prerequisite is there to stop the dependent call failing, not to save a call: both still run.
  if (kind === "prerequisite") expected.maxFailedCalls = 0;
  else if (change.collapse.length > 0 && calls(run).length > 0)
    expected.maxToolCalls = neededCalls(run, change.collapse);
  if (change.dedupeRetries.length > 0) expected.maxFailedCalls = 1;
  if (change.skillSteps.length > 0) expected.maxSearches = 1;
  if (methodForKind(kind) === "replay") Object.assign(expected, outcomeDefaults(run));
  return expected;
}

/**
 * RC-76: a replayed run's drafted cost and time limits, read against the
 * replay's own baseline (`rebaseScorers`). `drafted` says which limits were
 * drafted (`draftedLimit`); a limit a person set stays as set.
 */
export function rebasedForReplay(
  expected: Expected,
  run: RunRecord,
  baseline: RunView,
  drafted: (scorer: Scorer) => boolean = draftedLimit(run),
): Expected {
  const limits: Scorer[] = [];
  if (expected.maxCostUsd != null) limits.push({ kind: "max_cost_usd", max: expected.maxCostUsd });
  if (expected.maxLatencyMs != null)
    limits.push({ kind: "max_latency_ms", max: expected.maxLatencyMs });
  const out = { ...expected };
  for (const limit of rebaseScorers(limits, baseline, drafted)) {
    if (limit.kind === "max_cost_usd") out.maxCostUsd = limit.max;
    else if (limit.kind === "max_latency_ms") out.maxLatencyMs = limit.max;
  }
  return out;
}

/**
 * RC-76: whether a cost or time limit was drafted, not set by a person: the one
 * `outcomeDefaults` drafts from the run's recording, or a task's own default
 * scorer (drafted from its live runs). The verdict and the per-scorer results
 * of a replay rebase the same limits.
 */
export function draftedLimit(
  run: RunRecord,
  taskScorers: readonly (Scorer & { source?: string })[] = [],
): (scorer: Scorer) => boolean {
  const recorded = outcomeDefaults(run);
  const defaults = taskScorers.filter((scorer) => scorer.source === "default");
  return (scorer) => {
    if (scorer.kind !== "max_cost_usd" && scorer.kind !== "max_latency_ms") return false;
    const fromRun = scorer.kind === "max_cost_usd" ? recorded.maxCostUsd : recorded.maxLatencyMs;
    return (
      scorer.max === fromRun ||
      defaults.some((item) => item.kind === scorer.kind && "max" in item && item.max === scorer.max)
    );
  };
}

/** The expected outcome in plain words, as the eval page lists it. */
export function describeExpected(
  expected: Expected,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const name = (id: string) => names.get(id) ?? id;
  const parts: string[] = [];
  if (expected.tool) parts.push(`finds ${name(expected.tool)} in the first list`);
  if (expected.maxToolCalls !== null)
    parts.push(
      `at most ${expected.maxToolCalls} ${expected.maxToolCalls === 1 ? "call" : "calls"}`,
    );
  if (expected.maxSearches !== null)
    parts.push(
      `at most ${expected.maxSearches} ${expected.maxSearches === 1 ? "search" : "searches"}`,
    );
  if (expected.maxFailedCalls !== null)
    parts.push(
      expected.maxFailedCalls === 0
        ? "no failed call"
        : `at most ${expected.maxFailedCalls} failed`,
    );
  if (expected.avoidTools.length > 0)
    parts.push(`never calls ${expected.avoidTools.map(name).join(", ")}`);
  if (expected.endsWell) parts.push(SCORER_LABELS.ends_well.toLowerCase());
  if (expected.maxSelfCorrections != null)
    parts.push(
      expected.maxSelfCorrections === 0
        ? "no self-correction"
        : `at most ${expected.maxSelfCorrections} ${expected.maxSelfCorrections === 1 ? "self-correction" : "self-corrections"}`,
    );
  if (expected.maxCostUsd != null) parts.push(`costs at most ${formatUsd(expected.maxCostUsd)}`);
  if (expected.maxLatencyMs != null)
    parts.push(`takes at most ${formatSeconds(expected.maxLatencyMs)}`);
  if (parts.length === 0) return "No expected outcome";
  const text = parts.join(", ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** A stored or posted expectation read strictly. */
export function parseExpected(value: unknown): Expected {
  if (!value || typeof value !== "object") return { ...NO_EXPECTATION, avoidTools: [] };
  const record = value as Record<string, unknown>;
  const tool =
    typeof record.tool === "string" && record.tool.trim().length > 0 ? record.tool.trim() : null;
  return {
    tool,
    maxToolCalls: num(record.maxToolCalls),
    maxSearches: num(record.maxSearches),
    maxFailedCalls: num(record.maxFailedCalls),
    avoidTools: Array.isArray(record.avoidTools)
      ? [
          ...new Set(
            record.avoidTools
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim()),
          ),
        ]
      : [],
    endsWell: typeof record.endsWell === "boolean" ? record.endsWell : null,
    maxSelfCorrections: num(record.maxSelfCorrections),
    maxCostUsd: money(record.maxCostUsd),
    maxLatencyMs: num(record.maxLatencyMs),
  };
}
