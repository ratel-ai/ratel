import { selfCorrectionsOf } from "@/lib/views/task-scorers/outcome";
import { type ReplayWork, scoreReplaySide } from "@/lib/views/task-scorers/replay";
import {
  SCORER_KINDS,
  type Scorer,
  type ScorerKind,
  type ScorerRun,
} from "@/lib/views/task-scorers/types";
import type { EvalChange, EvalChecks, EvalVerdict } from "./types";

type LimitKind = Extract<Scorer, { max: number }>["kind"];

const LIMIT_KINDS: ReadonlySet<ScorerKind> = new Set<LimitKind>([
  "max_self_corrections",
  "max_latency_ms",
  "max_cost_usd",
  "max_tool_calls",
]);

/** What an eval itself says about its checks. */
export interface EvalScoring {
  checks: EvalChecks;
  expectedTool: string | null;
  criteria: string;
}

/**
 * The scorers one eval is held to (Q3): every enabled scorer of each of its
 * tasks, the stricter limit when two tasks set one, then the eval's own
 * checks on top: off removes a scorer, a limit replaces the tasks' limit
 * (even a looser one), and the eval's expected tool and criteria replace the
 * tasks'. Ordered as `SCORER_KINDS`. Pure.
 */
export function effectiveScorers(
  taskScorers: readonly (readonly Scorer[])[],
  scoring: EvalScoring,
): Scorer[] {
  const merged = new Map<ScorerKind, Scorer>();
  for (const scorer of taskScorers.flat()) {
    const held = merged.get(scorer.kind);
    if (!held) merged.set(scorer.kind, scorer);
    else if ("max" in held && "max" in scorer && scorer.max < held.max)
      merged.set(scorer.kind, scorer);
  }
  if (scoring.expectedTool)
    merged.set("expected_tool", { kind: "expected_tool", tool: scoring.expectedTool });
  if (scoring.criteria.trim())
    merged.set("judge_criteria", { kind: "judge_criteria", criteria: scoring.criteria.trim() });
  for (const kind of SCORER_KINDS) {
    const check = scoring.checks[kind];
    if (!check) continue;
    if (!check.on) merged.delete(kind);
    else if (LIMIT_KINDS.has(kind) && typeof check.max === "number")
      merged.set(kind, { kind: kind as LimitKind, max: check.max });
    else if (kind === "ends_well") merged.set(kind, { kind });
  }
  return SCORER_KINDS.flatMap((kind) => merged.get(kind) ?? []);
}

/**
 * Each scorer's verdict on one replay, with what was measured and the limit.
 * The expected tool reads the replay's calls when its search list is not
 * known (a replay's searches are the harness's). `passed`: false on any fail,
 * true on a pass and no fail, null when nothing could be measured.
 */
export function verdictsOf(
  run: ScorerRun & ReplayWork,
  scorers: readonly Scorer[],
): { verdicts: EvalVerdict[]; passed: boolean | null } {
  const results = scoreReplaySide(run, scorers);
  const verdicts = scorers.map((scorer, index): EvalVerdict => {
    const result = results[index]!;
    if (scorer.kind === "expected_tool" && result.status === "skip" && run.calls) {
      const called = run.calls.includes(scorer.tool);
      return {
        kind: scorer.kind,
        status: called ? "pass" : "fail",
        measured: called ? "called" : "not called",
        limit: scorer.tool,
        detail: called ? "called" : "not called",
      };
    }
    return {
      kind: scorer.kind,
      status: result.status,
      measured: result.status === "skip" ? null : measuredOf(run, scorer),
      limit: limitOf(scorer),
      detail: result.detail,
    };
  });
  const passed = verdicts.some((v) => v.status === "fail")
    ? false
    : verdicts.some((v) => v.status === "pass")
      ? true
      : null;
  return { verdicts, passed };
}

/** One eval's change from the previous completed run. Null when this run has no verdict. */
export function changeFrom(
  previous: boolean | null | undefined,
  now: boolean | null,
): EvalChange | null {
  if (now === null) return null;
  if (previous === null || previous === undefined) return "new";
  if (previous && !now) return "now_fails";
  if (!previous && now) return "fixed";
  return "same";
}

function measuredOf(run: ScorerRun, scorer: Scorer): number | string | null {
  switch (scorer.kind) {
    case "max_tool_calls":
      return run.calls?.length ?? null;
    case "max_latency_ms":
      return run.latencyMs ?? null;
    case "max_cost_usd":
      return run.costUsd ?? null;
    case "max_self_corrections":
      return selfCorrectionsOf(run);
    case "expected_tool":
      return run.firstList ? run.firstList.indexOf(scorer.tool) + 1 || null : null;
    case "ends_well":
    case "judge_criteria":
      return null;
  }
}

function limitOf(scorer: Scorer): number | string | null {
  if ("max" in scorer) return scorer.max;
  if (scorer.kind === "expected_tool") return scorer.tool;
  return null;
}
