import type { EvalResult } from "./types";

/**
 * RC-293: a fix simulated over a suite of the eval set. Each eval is replayed
 * as recorded (`before`, the agent today) and with the fix (`after`), and the
 * two verdicts are compared. Pure, client-safe.
 */

/** Which evals a simulation runs. `related` (the fix's own tasks) is the default. */
export type SimulationSuite =
  | { kind: "related" }
  | { kind: "all" }
  | { kind: "failing" }
  | { kind: "task"; workflowId: string }
  | { kind: "list"; evalIds: string[] };

export const SIMULATION_SUITE_LABELS: Record<SimulationSuite["kind"], string> = {
  related: "Related tasks",
  all: "All evals",
  failing: "Failing today",
  task: "Task",
  list: "Added evals",
};

/**
 * One eval's outcome against today. `unverified` (Q5): it passes with the fix
 * where it failed today, but a stand-in model answered a tool call of that
 * replay, so the pass is not counted as fixed.
 */
export type SimulationOutcome = "fixed" | "broke" | "same" | "unverified";

/** The evals of the set to choose from, the fix's tasks, and the evals that failed in the latest manual or nightly run. */
export interface SuiteContext {
  evals: readonly { id: string; tasks: readonly string[] }[];
  fixTasks: readonly string[];
  failingToday: ReadonlySet<string>;
}

/** One eval of a simulation: each side's result (`after` null when the fix does not touch it) and the outcome against today. */
export interface SimulationRow {
  evalId: string;
  before: EvalResult | null;
  after: EvalResult | null;
  outcome: SimulationOutcome | null;
}

export interface SimulationTally {
  total: number;
  passed: number;
  today: number;
  fixed: number;
  broke: number;
  unverified: number;
}

/** What `compareSides` reads of one side. */
export type SideVerdict = Pick<EvalResult, "passed" | "toolAnswers" | "generated">;

/** The eval ids of a suite, in the order of the set, and its label for the simulation's line. */
export function selectSuite(
  suite: SimulationSuite,
  context: SuiteContext,
): { evalIds: string[]; label: string } {
  const pick = (keep: (item: SuiteContext["evals"][number]) => boolean) =>
    context.evals.filter(keep).map((item) => item.id);
  switch (suite.kind) {
    case "related": {
      const tasks = new Set(context.fixTasks);
      return {
        evalIds: pick((item) => item.tasks.some((task) => tasks.has(task))),
        label: SIMULATION_SUITE_LABELS.related,
      };
    }
    case "all":
      return { evalIds: pick(() => true), label: SIMULATION_SUITE_LABELS.all };
    case "failing":
      return {
        evalIds: pick((item) => context.failingToday.has(item.id)),
        label: SIMULATION_SUITE_LABELS.failing,
      };
    case "task":
      return {
        evalIds: pick((item) => item.tasks.includes(suite.workflowId)),
        label: `${SIMULATION_SUITE_LABELS.task} ${suite.workflowId}`,
      };
    case "list": {
      const wanted = new Set(suite.evalIds);
      return { evalIds: pick((item) => wanted.has(item.id)), label: SIMULATION_SUITE_LABELS.list };
    }
  }
}

/** The suite a run's label names, for "Run again". A label of no other suite is a list of the run's evals. */
export function suiteOfRun(label: string, evalIds: readonly string[]): SimulationSuite {
  if (label === SIMULATION_SUITE_LABELS.related) return { kind: "related" };
  if (label === SIMULATION_SUITE_LABELS.all) return { kind: "all" };
  if (label === SIMULATION_SUITE_LABELS.failing) return { kind: "failing" };
  const task = `${SIMULATION_SUITE_LABELS.task} `;
  if (label.startsWith(task) && label.length > task.length)
    return { kind: "task", workflowId: label.slice(task.length) };
  return { kind: "list", evalIds: [...evalIds] };
}

/** The suite of an action's input; absent is the default. Null when the input names no suite this knows. */
export function parseSimulationSuite(input: unknown): SimulationSuite | null {
  if (input === undefined || input === null) return { kind: "related" };
  if (typeof input !== "object") return null;
  const { kind, workflowId, evalIds } = input as Record<string, unknown>;
  switch (kind) {
    case "related":
    case "all":
    case "failing":
      return { kind };
    case "task":
      return typeof workflowId === "string" && workflowId ? { kind, workflowId } : null;
    case "list": {
      const ids = Array.isArray(evalIds)
        ? evalIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      return ids.length > 0 ? { kind, evalIds: ids } : null;
    }
    default:
      return null;
  }
}

/**
 * One eval's outcome. `after` null: the fix changes nothing the eval's model
 * sees, so there is one replay and the outcome is today's (`same`). Null when
 * a side has no verdict (an error, or nothing measured).
 */
export function compareSides(
  before: SideVerdict | null,
  after: SideVerdict | null,
): SimulationOutcome | null {
  if (!before || before.passed === null) return null;
  if (!after) return "same";
  if (after.passed === null) return null;
  if (before.passed && !after.passed) return "broke";
  // A pass a tool stand-in or (RC-609) a model-written input helped is work the replay can't vouch for.
  if (!before.passed && after.passed)
    return after.toolAnswers.some((answer) => answer.source === "stand-in") ||
      (after.generated?.length ?? 0) > 0
      ? "unverified"
      : "fixed";
  return "same";
}

/** A simulation's line: evals run, how many pass with the fix (today's verdict when untouched) and today, and the outcomes that matter. */
export function tallySimulation(
  rows: readonly { before: SideVerdict | null; after: SideVerdict | null }[],
): SimulationTally {
  const tally = { total: rows.length, passed: 0, today: 0, fixed: 0, broke: 0, unverified: 0 };
  for (const { before, after } of rows) {
    if ((after ?? before)?.passed === true) tally.passed += 1;
    if (before?.passed === true) tally.today += 1;
    const outcome = compareSides(before, after);
    if (outcome && outcome !== "same") tally[outcome] += 1;
  }
  return tally;
}

/** Each eval's two sides, paired, with its outcome. */
export function simulationRowsOf(results: readonly EvalResult[]): SimulationRow[] {
  const byEval = new Map<string, { before: EvalResult | null; after: EvalResult | null }>();
  for (const result of results) {
    const row = byEval.get(result.evalId) ?? { before: null, after: null };
    row[result.side] = result;
    byEval.set(result.evalId, row);
  }
  return [...byEval].map(([evalId, { before, after }]) => ({
    evalId,
    before,
    after,
    outcome: compareSides(before, after),
  }));
}
