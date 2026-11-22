import { SCORER_KINDS, type Scorer, type ScorerKind } from "@/lib/views/task-scorers/types";
import { effectiveScorers } from "./domain/scoring";
import type {
  SimulationOutcome,
  SimulationRow,
  SimulationSuite,
  SimulationTally,
} from "./domain/simulation";
import { taskTag } from "./domain/task-name";
import type { Eval, EvalChange, EvalResult, SuggestionReason } from "./domain/types";

/**
 * RC-291: the Evals page as data. Pure, so the tables are tested without a
 * database or a DOM.
 */

export type ResultMark = "pass" | "fail" | "error" | "none";
export type CellMark = "pass" | "fail" | "dot";
export const RUN_FILTERS = ["all", "failing", "changed"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];
export const LAST_RUNS = 6;

export interface TaskTag {
  id: string;
  label: string;
}

export interface DefinitionRow {
  id: string;
  name: string;
  /** RC-315: a suggestion from a task, in the set and run like the others. */
  suggested: boolean;
  /** RC-616: on a score-based suggestion, the low reading that made it. */
  reason?: SuggestionReason;
  tasks: TaskTag[];
  checks: number;
  /** The last 6 results, oldest first, padded at the start with `none`. */
  last6: ResultMark[];
  last: ResultMark | null;
}

export interface RunSummary {
  passed: number;
  total: number;
  nowFails: number;
  fixed: number;
}

export interface RunTableRow {
  evalId: string;
  name: string;
  tasks: TaskTag[];
  cells: Partial<Record<ScorerKind, CellMark>>;
  passed: boolean | null;
  /** From the run before; a simulation's is its outcome against today (E4). */
  change: RowChange | null;
  /** A changed result (now fails, fixed, broke, unverified) is outlined. */
  outlined: boolean;
  error: string | null;
  /** RC-309: "2 of 3" for an eval that ran several times (a simulated person); null otherwise. */
  attempts: string | null;
}

export type RowChange = EvalChange | SimulationOutcome;

/** The "Run evals" menu (E3): each suite with how many evals it would run. */
export interface RunEvalsMenu {
  related: number;
  all: number;
  failing: number;
  tasks: (TaskTag & { count: number })[];
}

export interface RunEvalsOption {
  label: string;
  count: number;
  suite: SimulationSuite;
}

export interface RunTable {
  columns: ScorerKind[];
  rows: RunTableRow[];
  counts: Record<RunFilter, number>;
}

/** The Evals tab: one row per eval, filtered by task when one is given. `recent` is newest first. */
export function definitionRows(
  evals: readonly Eval[],
  recent: ReadonlyMap<string, readonly EvalResult[]>,
  scorersByTask: ReadonlyMap<string, readonly Scorer[]>,
  names: ReadonlyMap<string, string>,
  task?: string,
  status: "suggested" | null = null,
): DefinitionRow[] {
  return evals
    .filter((item) => (!task || item.tasks.includes(task)) && (!status || item.status === status))
    .map((item) => {
      const marks = (recent.get(item.id) ?? []).slice(0, LAST_RUNS).map(markOf).reverse();
      return {
        id: item.id,
        name: item.name,
        suggested: item.status === "suggested",
        ...(item.status === "suggested" && item.suggestionReason
          ? { reason: item.suggestionReason }
          : {}),
        tasks: tagsOf(item.tasks, names),
        checks: effectiveScorers(
          item.tasks.map((id) => scorersByTask.get(id) ?? []),
          item,
        ).length,
        last6: [...Array<ResultMark>(LAST_RUNS - marks.length).fill("none"), ...marks],
        last: marks.at(-1) ?? null,
      };
    });
}

export function runSummary(results: readonly Pick<EvalResult, "passed" | "change">[]): RunSummary {
  return {
    passed: results.filter((result) => result.passed === true).length,
    total: results.length,
    nowFails: results.filter((result) => result.change === "now_fails").length,
    fixed: results.filter((result) => result.change === "fixed").length,
  };
}

/** "3 fixed · 1 now fails"; empty when nothing changed. */
export function changeText(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.fixed > 0) parts.push(`${summary.fixed} fixed`);
  if (summary.nowFails > 0)
    parts.push(`${summary.nowFails} now ${summary.nowFails === 1 ? "fails" : "fail"}`);
  return parts.join(" · ");
}

/** One run as a table: a column for each scorer any result used, in `SCORER_KINDS` order. */
export function runTable(
  results: readonly EvalResult[],
  evals: readonly Eval[],
  names: ReadonlyMap<string, string>,
  filter: RunFilter,
): RunTable {
  return tableOf(results, evals, names, filter);
}

function tableOf(
  results: readonly (Omit<EvalResult, "change"> & { change: RowChange | null })[],
  evals: readonly Eval[],
  names: ReadonlyMap<string, string>,
  filter: RunFilter,
): RunTable {
  const byId = new Map(evals.map((item) => [item.id, item]));
  const used = new Set(results.flatMap((result) => result.verdicts.map((verdict) => verdict.kind)));
  const columns = SCORER_KINDS.filter((kind) => used.has(kind));
  const all = results.map((result): RunTableRow => {
    const item = byId.get(result.evalId);
    const cells: Partial<Record<ScorerKind, CellMark>> = {};
    for (const kind of columns) {
      const verdict = result.verdicts.find((entry) => entry.kind === kind);
      cells[kind] = verdict && verdict.status !== "skip" ? verdict.status : "dot";
    }
    return {
      evalId: result.evalId,
      name: item?.name ?? "Deleted eval",
      tasks: tagsOf(item?.tasks ?? [], names),
      cells,
      passed: result.passed,
      change: result.change,
      outlined: isChanged(result.change),
      error: result.error,
      attempts:
        result.attempts && result.passed !== null
          ? `${result.attempts.passed} of ${result.attempts.total}`
          : null,
    };
  });
  all.sort((a, b) => a.name.localeCompare(b.name));
  const failing = (row: RunTableRow) => row.passed !== true;
  const changed = (row: RunTableRow) => row.outlined;
  const rows =
    filter === "failing" ? all.filter(failing) : filter === "changed" ? all.filter(changed) : all;
  return {
    columns,
    rows,
    counts: {
      all: all.length,
      failing: all.filter(failing).length,
      changed: all.filter(changed).length,
    },
  };
}

/**
 * RC-294: a simulation as the same table (E4). Each eval's cells are its
 * result with the fix, or today's when the fix does not touch it, and its
 * change is its outcome against today.
 */
export function simulationTable(
  rows: readonly SimulationRow[],
  evals: readonly Eval[],
  names: ReadonlyMap<string, string>,
  filter: RunFilter,
): RunTable {
  const shown = rows.flatMap((row) => {
    const result = row.after ?? row.before;
    return result ? [{ ...result, change: row.outcome }] : [];
  });
  return tableOf(shown, evals, names, filter);
}

/** The menu's entries: the fix's own tasks, all evals and those failing today, then one entry per task. An entry with no evals is off. */
export function runEvalsOptions(menu: RunEvalsMenu): {
  suites: RunEvalsOption[];
  tasks: RunEvalsOption[];
} {
  return {
    suites: [
      { label: "Related tasks", count: menu.related, suite: { kind: "related" } },
      { label: "All evals", count: menu.all, suite: { kind: "all" } },
      { label: "Failing today", count: menu.failing, suite: { kind: "failing" } },
    ],
    tasks: menu.tasks.map((task) => ({
      label: task.label,
      count: task.count,
      suite: { kind: "task", workflowId: task.id },
    })),
  };
}

/** A simulation's line in words: "3/5" pass with the fix, "today 2", "1 fixed · 1 broke". */
export function simulationLineText(tally: SimulationTally): {
  pass: string;
  today: string;
  change: string;
} {
  const parts = [
    tally.fixed > 0 ? `${tally.fixed} fixed` : null,
    tally.broke > 0 ? `${tally.broke} broke` : null,
    tally.unverified > 0 ? `${tally.unverified} unverified` : null,
  ].filter(Boolean);
  return {
    pass: `${tally.passed}/${tally.total}`,
    today: `today ${tally.today}`,
    change: parts.length > 0 ? parts.join(" · ") : "No change",
  };
}

export function parseRunFilter(value: string | string[] | undefined): RunFilter {
  return RUN_FILTERS.find((filter) => filter === value) ?? "all";
}

function markOf(result: Pick<EvalResult, "passed" | "error">): ResultMark {
  if (result.passed === true) return "pass";
  if (result.passed === false) return "fail";
  return "error";
}

function isChanged(change: RowChange | null): boolean {
  return (
    change === "now_fails" || change === "fixed" || change === "broke" || change === "unverified"
  );
}

function tagsOf(tasks: readonly string[], names: ReadonlyMap<string, string>): TaskTag[] {
  return tasks.map((id) => taskTag(id, names));
}
