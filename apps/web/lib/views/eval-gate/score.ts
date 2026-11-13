import { bootstrapInterval } from "@/lib/synthesis/match-quality/replay";
import {
  doesTheWork,
  type Scorer,
  type ScorerKind,
  type ScorerResult,
  scoreRun,
  sideScore,
} from "@/lib/views/task-scorers";
import { mapTool, type SimulatedRun } from "./simulate";
import {
  type CaseResult,
  CHECK_GROUP,
  type CheckGroup,
  type CheckResult,
  type EvalCase,
  type Expected,
  type FixChange,
  type MethodTally,
  type RunView,
  type SideResult,
  type SimulationSummary,
  type Tally,
  type Verdict,
} from "./types";

/**
 * Scoring the gate: each run's expected outcome as checks, read on both sides
 * of the simulation, then the set as a pass rate and a mean score with a paired
 * interval on the change. The right-tool check is Quality's own rank credit
 * (`hitCredit`: half for being in the list the agent saw, the rest by rank), so
 * a score here moves in the units the Quality meter already uses. Pure.
 *
 * RC-61: a check counts only when both sides measured it (a side that can't
 * know a number says so instead of reading it off an edited list), and the
 * verdict reads the holdout runs only: the insight's own evidence is scored
 * apart.
 */

/** Below this many simulated runs the gate reads "too few to tell". */
export const MIN_RUNS_FOR_VERDICT = 3;
/**
 * RC-69: the share of replays whose side without the fix must take the
 * recorded path for the replay to give a verdict. Below it the replay isn't
 * re-enacting the runs, so a difference between its sides says nothing about
 * the fix: the gate reads "replay unreliable".
 */
export const MIN_REPLAY_FIDELITY = 0.5;

const SCORER_CHECK_KIND = {
  expected_tool: "right_tool",
  judge_criteria: "criteria",
  max_tool_calls: "max_tool_calls",
  ends_well: "ends_well",
  max_self_corrections: "max_self_corrections",
  max_cost_usd: "max_cost",
  max_latency_ms: "max_latency",
} as const satisfies Record<ScorerKind, CheckResult["kind"]>;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function hasChecks(expected: Expected, criteria = ""): boolean {
  return (
    expected.tool !== null ||
    expected.maxToolCalls !== null ||
    expected.maxSearches !== null ||
    expected.maxFailedCalls !== null ||
    expected.avoidTools.length > 0 ||
    expected.endsWell === true ||
    expected.maxSelfCorrections != null ||
    expected.maxCostUsd != null ||
    expected.maxLatencyMs != null ||
    criteria.trim().length > 0
  );
}

const NOT_MEASURED = "not measured";

function check(
  kind: CheckResult["kind"],
  pass: boolean,
  detail: string,
  score = pass ? 1 : 0,
): CheckResult {
  return { kind, pass, score, detail, group: CHECK_GROUP[kind], measured: true };
}

function unmeasured(kind: CheckResult["kind"]): CheckResult {
  return {
    kind,
    pass: false,
    score: 0,
    detail: NOT_MEASURED,
    group: CHECK_GROUP[kind],
    measured: false,
  };
}

/** `criteria`: the judge's reading of the person's words on this side; undefined when there are none, null when unjudged. */
export interface SideJudgement {
  criteria?: boolean | null;
  taskCriteria?: boolean | null;
}

/**
 * The checks on one side of a run. `after` maps the expected tool through the
 * change, so a merge's stand-in counts as the tool it replaces.
 */
export function checkSide(
  view: RunView,
  expected: Expected,
  change: FixChange | null,
  judged: SideJudgement = {},
): SideResult {
  const map = (id: string) => (change ? mapTool(id, change) : id);
  const results = scoreRun(view, scorersOf(expected, map));
  const scored = results.map(scorerCheck);
  const checks = scored.filter((item) => item.group === "target");
  const rank = results.find((item) => item.kind === "expected_tool")?.rank ?? null;
  const calls = view.calls;
  if (expected.maxSearches !== null) {
    checks.push(
      view.searches === null
        ? unmeasured("max_searches")
        : check(
            "max_searches",
            view.searches <= expected.maxSearches,
            plural(view.searches, "search", "searches"),
          ),
    );
  }
  if (expected.maxFailedCalls !== null) {
    checks.push(
      view.failed === null
        ? unmeasured("max_failed_calls")
        : check(
            "max_failed_calls",
            view.failed <= expected.maxFailedCalls,
            `${view.failed} failed`,
          ),
    );
  }
  if (expected.avoidTools.length > 0) {
    if (calls === null) checks.push(unmeasured("avoid_tools"));
    else {
      const avoided = expected.avoidTools.map(map);
      const called = calls.filter((id) => avoided.includes(id)).length;
      checks.push(
        check(
          "avoid_tools",
          called === 0,
          called === 0 ? "not called" : `called ${plural(called, "time", "times")}`,
        ),
      );
    }
  }
  checks.push(...scored.filter((item) => item.group === "outcome"));
  // RC-76: a merge's replay is held to the work the run did, so stopping early (to ask, or giving up) never reads as fewer calls for free.
  const work = doesTheWork(view);
  if (work) checks.push(check("does_the_work", work.pass, work.detail));
  if (judged.criteria !== undefined) {
    checks.push(
      judged.criteria === null
        ? unmeasured("criteria")
        : check(
            "criteria",
            judged.criteria,
            judged.criteria ? "meets the criteria" : "misses the criteria",
          ),
    );
  }
  if (judged.taskCriteria !== undefined) {
    checks.push(
      judged.taskCriteria === null
        ? unmeasured("criteria")
        : check("criteria", judged.taskCriteria, "task criteria"),
    );
  }
  return sideOf(checks, {
    rank,
    calls: calls ? calls.length : null,
    searches: view.searches,
    failed: view.failed,
  });
}

function scorersOf(expected: Expected, map: (id: string) => string): Scorer[] {
  const scorers: Scorer[] = [];
  if (expected.tool !== null) scorers.push({ kind: "expected_tool", tool: map(expected.tool) });
  if (expected.maxToolCalls !== null)
    scorers.push({ kind: "max_tool_calls", max: expected.maxToolCalls });
  if (expected.endsWell === true) scorers.push({ kind: "ends_well" });
  if (expected.maxSelfCorrections != null)
    scorers.push({ kind: "max_self_corrections", max: expected.maxSelfCorrections });
  if (expected.maxCostUsd != null) scorers.push({ kind: "max_cost_usd", max: expected.maxCostUsd });
  if (expected.maxLatencyMs != null)
    scorers.push({ kind: "max_latency_ms", max: expected.maxLatencyMs });
  return scorers;
}

function scorerCheck(result: ScorerResult): CheckResult {
  const kind = SCORER_CHECK_KIND[result.kind];
  return result.status === "skip"
    ? unmeasured(kind)
    : check(kind, result.status === "pass", result.detail, result.score);
}

/** A side's pass and score over its measured checks; a side short of the run's work scores 0 (`sideScore`). */
function sideOf(
  checks: CheckResult[],
  counts: Pick<SideResult, "rank" | "calls" | "searches" | "failed">,
): SideResult {
  const scored = checks.filter((item) => item.measured !== false);
  const work = scored.find((item) => item.kind === "does_the_work") ?? null;
  const score = sideScore(
    scored.map((item) => item.score),
    work,
  );
  return {
    pass: scored.length > 0 && scored.every((item) => item.pass),
    score,
    checks,
    rank: counts.rank,
    calls: counts.calls,
    searches: counts.searches,
    failed: counts.failed,
  };
}

/**
 * Keep a check scored only where both sides measured it: a side that can't
 * know a number can't be compared with one that can.
 */
export function pairSides(
  before: SideResult,
  after: SideResult,
): { before: SideResult; after: SideResult; comparable: number } {
  const measured = (side: SideResult) =>
    new Set(side.checks.filter((item) => item.measured !== false).map((item) => item.kind));
  const inBefore = measured(before);
  const inAfter = measured(after);
  const both = new Set([...inBefore].filter((kind) => inAfter.has(kind)));
  const keep = (side: SideResult): SideResult =>
    sideOf(
      side.checks.map((item) =>
        both.has(item.kind) || item.measured === false
          ? item
          : {
              ...item,
              measured: false,
              pass: false,
              score: 0,
              detail: `${item.detail} (no reading on the other side)`,
            },
      ),
      side,
    );
  return { before: keep(before), after: keep(after), comparable: both.size };
}

export interface ScoreOptions {
  /** The judge's reading of the person's criteria, by side; absent when there are none. */
  criteria?: { before: boolean | null; after: boolean | null };
  taskCriteria?: { before: boolean | null; after: boolean | null };
}

export function scoreCase(
  evalCase: Pick<EvalCase, "id" | "turnId" | "expected">,
  simulated: SimulatedRun | null,
  change: FixChange,
  options: ScoreOptions = {},
): CaseResult {
  const base = { caseId: evalCase.id, turnId: evalCase.turnId };
  if (!simulated)
    return { ...base, simulated: false, skipped: "run-gone", before: null, after: null };
  if (simulated.skipped)
    return { ...base, simulated: false, skipped: simulated.skipped, before: null, after: null };
  if (!hasChecks(evalCase.expected) && !options.criteria && !options.taskCriteria)
    return { ...base, simulated: false, skipped: "no-checks", before: null, after: null };
  const paired = pairSides(
    checkSide(simulated.before, evalCase.expected, null, {
      ...(options.criteria ? { criteria: options.criteria.before } : {}),
      ...(options.taskCriteria ? { taskCriteria: options.taskCriteria.before } : {}),
    }),
    checkSide(simulated.after, evalCase.expected, change, {
      ...(options.criteria ? { criteria: options.criteria.after } : {}),
      ...(options.taskCriteria ? { taskCriteria: options.taskCriteria.after } : {}),
    }),
  );
  if (paired.comparable === 0) {
    return {
      ...base,
      simulated: false,
      skipped: "cant-simulate",
      before: paired.before,
      after: paired.after,
      methodNote: "No check could be read on both sides",
    };
  }
  return { ...base, simulated: true, skipped: null, before: paired.before, after: paired.after };
}

function tally(sides: readonly SideResult[]): Tally {
  if (sides.length === 0) return { passed: 0, total: 0, passRate: null, score: null };
  const passed = sides.filter((side) => side.pass).length;
  return {
    passed,
    total: sides.length,
    passRate: passed / sides.length,
    score: sides.reduce((sum, side) => sum + side.score, 0) / sides.length,
  };
}

/** One group's reading of a side: pass when every measured check of the group passes; null when it has none. */
function groupSide(side: SideResult, group: CheckGroup): SideResult | null {
  const checks = side.checks.filter(
    (item) => (item.group ?? "target") === group && item.measured !== false,
  );
  if (checks.length === 0) return null;
  return {
    ...side,
    checks,
    pass: checks.every((item) => item.pass),
    score: checks.reduce((sum, item) => sum + item.score, 0) / checks.length,
  };
}

function groupTally(
  results: readonly CaseResult[],
  group: CheckGroup,
): { before: Tally; after: Tally } {
  const pairs = results.flatMap((result) => {
    const before = groupSide(result.before!, group);
    const after = groupSide(result.after!, group);
    return before && after ? [{ before, after }] : [];
  });
  return {
    before: tally(pairs.map((pair) => pair.before)),
    after: tally(pairs.map((pair) => pair.after)),
  };
}

/** Holdout runs by method, the reasons the rest couldn't be simulated, and how often a replay without the fix took the recorded path. */
export function methodTally(results: readonly CaseResult[]): MethodTally {
  const out: MethodTally = { rerank: 0, replay: 0, none: 0, reasons: [], fidelity: null };
  const reasons = new Map<string, number>();
  let matched = 0;
  let replays = 0;
  for (const result of results) {
    if (result.role === "evidence") continue;
    if (result.simulated) out[result.method ?? "rerank"] += 1;
    else if (result.skipped !== "not-affected" && result.skipped !== "no-checks") {
      out.none += 1;
      if (result.methodNote)
        reasons.set(result.methodNote, (reasons.get(result.methodNote) ?? 0) + 1);
    }
    if (result.simulated && result.replay) {
      replays += 1;
      if (result.replay.controlMatchesRecording) matched += 1;
    } else if (result.replayFailed) {
      // Replayed and made no calls: it took no path at all.
      replays += 1;
    }
  }
  out.reasons = [...reasons]
    .map(([note, runs]) => ({ note, runs }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);
  out.fidelity = replays > 0 ? { matched, total: replays } : null;
  return out;
}

/**
 * The set's reading, on the holdout runs. Better or worse only when the paired
 * interval on the mean score change excludes zero; with fewer than
 * `MIN_RUNS_FOR_VERDICT` runs simulated it is too few to tell. The evidence
 * runs get their own pass rates, never the verdict. A set where no run could
 * be simulated by any method reads "can't simulate".
 */
export function summarize(
  results: readonly CaseResult[],
  seed: string,
  unsupported = false,
): SimulationSummary {
  const done = results.filter((result) => result.simulated && result.before && result.after);
  const simulated = done.filter((result) => result.role !== "evidence");
  const evidenceRuns = done.filter((result) => result.role === "evidence");
  const before = tally(simulated.map((result) => result.before!));
  const after = tally(simulated.map((result) => result.after!));
  const deltas = simulated.map((result) => result.after!.score - result.before!.score);
  const interval = deltas.length > 0 ? bootstrapInterval(deltas, seed) : null;
  const methods = methodTally(results);
  let verdict: Verdict;
  if (unsupported) verdict = "unsupported";
  else if (
    methods.fidelity &&
    methods.fidelity.matched / methods.fidelity.total < MIN_REPLAY_FIDELITY
  )
    verdict = "unreliable";
  else if (simulated.length === 0 && methods.none > 0) verdict = "unsupported";
  else if (simulated.length < MIN_RUNS_FOR_VERDICT || !interval) verdict = "too-few";
  else if (interval.low > 0) verdict = "better";
  else if (interval.high < 0) verdict = "worse";
  else verdict = "same";
  const hasEvidence = results.some((result) => result.role === "evidence");
  return {
    before,
    after,
    interval,
    verdict,
    nCases: results.filter((result) => result.role !== "evidence").length,
    nSimulated: simulated.length,
    evidence: hasEvidence
      ? {
          before: tally(evidenceRuns.map((result) => result.before!)),
          after: tally(evidenceRuns.map((result) => result.after!)),
          nSimulated: evidenceRuns.length,
        }
      : null,
    breakdown: {
      target: groupTally(simulated, "target"),
      outcome: groupTally(simulated, "outcome"),
      criteria: groupTally(simulated, "criteria"),
    },
    methods,
  };
}
