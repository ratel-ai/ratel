import { getDb } from "@/lib/platform/db/client";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { type FixContext, loadFixContext } from "@/lib/views/eval-gate/service";
import type { Fix } from "@/lib/views/fixes/types";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import {
  type SimulationOutcome,
  type SimulationRow,
  selectSuite,
  tallySimulation,
} from "./domain/simulation";
import { suiteText, taskOfSuite, taskTag } from "./domain/task-name";
import { type Eval, type EvalResult, type EvalRun, IN_SET_STATUSES } from "./domain/types";
import { evalsEnabledForActor } from "./gate";
import { taskNames } from "./page";
import { failingToday, fixSimulations, type SimulationLine, simulationRows } from "./simulation";
import { enabledTaskScorers } from "./task-scorers";
import { evalRules, neighbours, type RuleWithSource } from "./test-view";
import {
  type RunEvalsMenu,
  type RunFilter,
  type RunTable,
  simulationTable,
  type TaskTag,
} from "./view";

/**
 * RC-294: the fix page and its simulations (E1–E4, F2) as data. Each loader
 * returns null when `cloud-eval-gate` is off for the person, or when the fix or
 * the simulation is not in the project: the page then does not exist.
 */

export interface FixPageDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  loadFix?: (projectId: string, fixId: string) => Promise<FixContext | null>;
}

/** What the fix changes, in the page's words. */
export interface FixSummary {
  id: string;
  title: string;
  kindLabel: string;
  /** The tools it changes, and the tools it makes (a merge's new tool). */
  tools: string[];
  becomes: string[];
  /** The change, one line each, when the fix says it in words. */
  changes: string[];
  /** One line with its numbers. */
  why: string;
}

export interface FixPageModel {
  fix: FixSummary;
  /** Each simulation with its tasks and its suite by name. */
  lines: (SimulationLine & { taskTags: TaskTag[]; suite: string })[];
  menu: RunEvalsMenu;
}

export interface SimulationPageModel {
  fix: FixSummary;
  run: EvalRun;
  /** The run's suite as the page says it (a task suite by the task's name). */
  suite: string;
  table: RunTable;
  tally: SimulationLine["tally"];
  /** The run's evals, for "Run again" and as the base of "Add evals". */
  evalIds: string[];
  /** Evals of the set the run left out: what "Add evals" offers. */
  addable: { id: string; name: string; tasks: TaskTag[] }[];
}

export interface FixTestPageModel {
  fix: FixSummary;
  run: EvalRun;
  suite: string;
  item: Eval;
  tasks: TaskTag[];
  rules: RuleWithSource[];
  before: EvalResult | null;
  /** Null when the fix does not touch this eval: one replay, "Same as today" (Q10). */
  after: EvalResult | null;
  outcome: SimulationOutcome | null;
  position: { index: number; total: number; prev: string | null; next: string | null } | null;
  replayHref: string | null;
}

/** The fix page (E1): what the fix changes, its evidence, one line per simulation, and the Run evals menu. */
export async function loadFixPage(
  projectId: string,
  actor: string,
  fixId: string,
  deps: FixPageDeps = {},
): Promise<FixPageModel | null> {
  const base = await fixBase(projectId, actor, fixId, deps);
  if (!base) return null;
  const { db, fix, store } = base;
  const evals = await store.listEvals(projectId, { statuses: IN_SET_STATUSES });
  const lines = await fixSimulations(projectId, fix.id, db);
  const taskIds = [
    ...new Set([
      ...evals.flatMap((item) => item.tasks),
      ...lines.flatMap((line) => [...line.tasks, ...(taskOfSuite(line.run.suite) ?? [])]),
    ]),
  ];
  const names = await taskNames(projectId, taskIds, db);
  const tag = (id: string) => taskTag(id, names);
  const fixTasks = fix.subject.tasks.map((task) => task.id);
  const failing = selectSuite(
    { kind: "failing" },
    { evals, fixTasks, failingToday: await failingToday(projectId, store) },
  ).evalIds.length;
  return {
    fix: summaryOf(fix),
    lines: lines.map((line) => ({
      ...line,
      taskTags: line.tasks.map(tag),
      suite: suiteText(line.run.suite, names),
    })),
    menu: {
      related: selectSuite({ kind: "related" }, { evals, fixTasks, failingToday: new Set() })
        .evalIds.length,
      all: evals.length,
      failing,
      tasks: [...new Set(evals.flatMap((item) => item.tasks))]
        .map((id) => ({
          ...tag(id),
          count: evals.filter((item) => item.tasks.includes(id)).length,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    },
  };
}

/** One simulation as the run table compared with today (E4). */
export async function loadSimulationPage(
  projectId: string,
  actor: string,
  fixId: string,
  runId: string,
  filter: RunFilter,
  deps: FixPageDeps = {},
): Promise<SimulationPageModel | null> {
  const base = await fixBase(projectId, actor, fixId, deps);
  if (!base) return null;
  const { db, fix, store } = base;
  const read = await simulationRows(projectId, runId, db);
  if (!read || read.run.fixId !== fix.id) return null;
  const evals = await store.listEvals(projectId);
  const inRun = new Set(read.rows.map((row) => row.evalId));
  const names = await taskNames(
    projectId,
    [...new Set([...evals.flatMap((item) => item.tasks), ...(taskOfSuite(read.run.suite) ?? [])])],
    db,
  );
  const tags = (ids: readonly string[]) => ids.map((id) => taskTag(id, names));
  return {
    fix: summaryOf(fix),
    run: read.run,
    suite: suiteText(read.run.suite, names),
    table: simulationTable(
      read.rows,
      evals.filter((item) => inRun.has(item.id)),
      names,
      filter,
    ),
    tally: tallySimulation(read.rows),
    evalIds: [...inRun],
    addable: evals
      .filter((item) => !inRun.has(item.id))
      .map((item) => ({ id: item.id, name: item.name, tasks: tags(item.tasks) })),
  };
}

/** One eval of a simulation (F2): both replays, or one when the fix does not touch it. */
export async function loadFixTestPage(
  projectId: string,
  actor: string,
  fixId: string,
  runId: string,
  evalId: string,
  deps: FixPageDeps = {},
): Promise<FixTestPageModel | null> {
  const base = await fixBase(projectId, actor, fixId, deps);
  if (!base) return null;
  const { db, fix, store } = base;
  const read = await simulationRows(projectId, runId, db);
  if (!read || read.run.fixId !== fix.id) return null;
  const row: SimulationRow | undefined = read.rows.find((entry) => entry.evalId === evalId);
  const item = row ? await store.getEval(projectId, evalId) : null;
  if (!row || !item) return null;
  const evals = await store.listEvals(projectId);
  const inRun = new Set(read.rows.map((entry) => entry.evalId));
  const names = await taskNames(
    projectId,
    [...item.tasks, ...(taskOfSuite(read.run.suite) ?? [])],
    db,
  );
  const scorers = await enabledTaskScorers(projectId, item.tasks, db);
  const order = simulationTable(
    read.rows,
    evals.filter((entry) => inRun.has(entry.id)),
    new Map(),
    "all",
  ).rows.map((entry) => entry.evalId);
  return {
    fix: summaryOf(fix),
    run: read.run,
    suite: suiteText(read.run.suite, names),
    item,
    tasks: item.tasks.map((id) => taskTag(id, names)),
    rules: evalRules(
      item.tasks.map((id) => scorers.get(id) ?? []),
      item,
    ),
    before: row.before,
    after: row.after,
    outcome: row.outcome,
    position: neighbours(order, item.id),
    replayHref: item.sourceTurnId
      ? `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(item.sourceTurnId)}`
      : null,
  };
}

/** What the page says the fix changes. */
export function summaryOf(fix: Fix): FixSummary {
  const detail = fix.detail;
  const becomes =
    detail.source === "craft"
      ? detail.crafted
          .map((tool) => tool.name)
          .filter((name) => !fix.subject.tools.some((tool) => tool.label === name))
      : [];
  const changes =
    detail.source === "craft"
      ? detail.change
      : detail.source === "issue" || detail.source === "intent"
        ? detail.changes
        : [];
  return {
    id: fix.id,
    title: fix.title,
    kindLabel: fix.kindLabel,
    tools: fix.subject.tools.map((tool) => tool.label),
    becomes,
    changes,
    why: fix.why,
  };
}

async function fixBase(projectId: string, actor: string, fixId: string, deps: FixPageDeps) {
  const db = deps.db ?? getDb();
  if (
    !(await evalsEnabledForActor(
      projectId,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return null;
  const ctx = await (deps.loadFix ?? loadFixContext)(projectId, fixId);
  if (!ctx || ctx.projectId !== projectId) return null;
  return { db, fix: ctx.fix, store: createDrizzleEvalStore(db) };
}
