import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { traceWorkflowLabels } from "@/lib/readings/trace-signals/schema";
import { evals as evalsTable, evalTasks } from "@/lib/views/evals/schema";
import { scorers as scorersTable } from "@/lib/views/scorers/schema";
import { taskEvalCases } from "@/lib/views/task-evals/schema";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import { simulationRowsOf, tallySimulation } from "./domain/simulation";
import { suiteText, taskDisplayName, taskOfSuite, taskTag } from "./domain/task-name";
import {
  type Eval,
  type EvalChange,
  type EvalResult,
  type EvalRun,
  IN_SET_STATUSES,
} from "./domain/types";
import { evalsEnabledForActor } from "./gate";
import type { EvalStatusFilter } from "./paths";
import { importTaskCases, type SuggestDeps, suggestTaskEvals } from "./suggest";
import { enabledTaskScorers } from "./task-scorers";
import { evalRules, neighbours, type RuleWithSource } from "./test-view";
import {
  type DefinitionRow,
  definitionRows,
  LAST_RUNS,
  type RunFilter,
  type RunSummary,
  type RunTable,
  runSummary,
  runTable,
  simulationTable,
  type TaskTag,
} from "./view";

/**
 * RC-291: what the Evals pages read. Each loader returns null when
 * `cloud-eval-gate` is off for the person, so the route 404s and reads nothing.
 */

export interface PageDeps extends SuggestDeps {
  flagDeps?: OrganizationFlagDeps;
}

export interface EvalsPageModel {
  rows: DefinitionRow[];
  /** Every eval in the set, suggested ones included. */
  evalCount: number;
  suggestedCount: number;
  taskCount: number;
  /** Every task an eval tests, for the filter. */
  tasks: TaskTag[];
  task: string | null;
  status: EvalStatusFilter;
  runCount: number;
}

export interface RunListRow {
  run: EvalRun;
  /** What it ran, with a task suite by the task's name. */
  suite: string;
  summary: RunSummary;
}

/** RC-317: one eval on a task page, with the change of its last result. */
export interface TaskEvalRow extends DefinitionRow {
  change: EvalChange | null;
}

export interface TaskEvalsModel {
  rows: TaskEvalRow[];
  /** The queued or running manual run that covers this task (all evals, or this task's). */
  live: EvalRun | null;
}

export interface RunPageModel {
  run: EvalRun;
  table: RunTable;
  summary: RunSummary;
  /** The completed run this one is compared with. */
  previous: EvalRun | null;
}

const logger = getLogger("evals/page");
const RUN_LIST_LIMIT = 50;

/** The Evals tab. Fills the set first: pinned and user cases import once, each task suggests up to 5. */
export async function loadEvalsPage(
  projectId: string,
  actor: string,
  task: string | null,
  deps: PageDeps = {},
  status: EvalStatusFilter = null,
): Promise<EvalsPageModel | null> {
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
  await fillEvalSet(projectId, { ...deps, db });
  const store = createDrizzleEvalStore(db);
  const [evals, runs] = [
    await store.listEvals(projectId, { statuses: IN_SET_STATUSES }),
    await store.listRuns(projectId, { limit: RUN_LIST_LIMIT }),
  ];
  const taskIds = [...new Set(evals.flatMap((item) => item.tasks))];
  const [names, scorers, recent] = [
    await taskNames(projectId, taskIds, db),
    await enabledTaskScorers(projectId, taskIds, db),
    await store.recentResults(
      projectId,
      evals.map((item) => item.id),
      LAST_RUNS,
    ),
  ];
  const tags = (ids: readonly string[]) => ids.map((id) => taskTag(id, names));
  const tested = [...new Set(evals.flatMap((item) => item.tasks))];
  return {
    rows: definitionRows(evals, recent, scorers, names, task ?? undefined, status),
    evalCount: evals.length,
    suggestedCount: evals.filter((item) => item.status === "suggested").length,
    taskCount: tested.length,
    tasks: tags(tested).sort((a, b) => a.label.localeCompare(b.label)),
    task,
    status,
    runCount: runs.length,
  };
}

/** A task page's Evals section (RC-317). Fills the set for this task first, as the Evals tab does. */
export async function loadTaskEvals(
  projectId: string,
  actor: string,
  taskId: string,
  deps: PageDeps = {},
): Promise<TaskEvalsModel | null> {
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
  await fillEvalSet(projectId, { ...deps, db }, [taskId]);
  const store = createDrizzleEvalStore(db);
  const evals = await store.listEvals(projectId, { statuses: IN_SET_STATUSES, workflowId: taskId });
  const taskIds = [...new Set(evals.flatMap((item) => item.tasks))];
  const [names, scorers, recent, runs] = [
    await taskNames(projectId, taskIds, db),
    await enabledTaskScorers(projectId, taskIds, db),
    await store.recentResults(
      projectId,
      evals.map((item) => item.id),
      LAST_RUNS,
    ),
    await store.listRuns(projectId, { kinds: ["manual"], limit: RUN_LIST_LIMIT }),
  ];
  const rows = definitionRows(evals, recent, scorers, names).map((row) => ({
    ...row,
    change: recent.get(row.id)?.[0]?.change ?? null,
  }));
  const live =
    runs.find(
      (run) =>
        (run.status === "queued" || run.status === "running") &&
        (run.suite === "All evals" || taskOfSuite(run.suite) === taskId),
    ) ?? null;
  return { rows, live };
}

/** The Runs tab: newest first, each with its pass count and change. */
export async function loadRunsPage(
  projectId: string,
  actor: string,
  deps: PageDeps = {},
): Promise<{ runs: RunListRow[]; evalCount: number } | null> {
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
  const store = createDrizzleEvalStore(db);
  const runs = await store.listRuns(projectId, { limit: RUN_LIST_LIMIT });
  const summaries = await store.runSummaries(
    projectId,
    runs.filter((run) => run.kind !== "simulation").map((run) => run.id),
  );
  // RC-293: a simulation has two sides per eval; its line counts each eval once, against today (broke reads as now fails).
  for (const run of runs.filter((item) => item.kind === "simulation")) {
    const { passed, total, broke, fixed } = tallySimulation(
      simulationRowsOf(await store.listResults(projectId, run.id)),
    );
    summaries.set(run.id, { passed, total, nowFails: broke, fixed });
  }
  const evalCount = (await store.listEvals(projectId, { statuses: IN_SET_STATUSES })).length;
  const names = await taskNames(
    projectId,
    [...new Set(runs.flatMap((run) => taskOfSuite(run.suite) ?? []))],
    db,
  );
  return {
    runs: runs.map((run) => ({
      run,
      suite: suiteText(run.suite, names),
      summary: summaries.get(run.id) ?? { passed: 0, total: 0, nowFails: 0, fixed: 0 },
    })),
    evalCount,
  };
}

/** One run as a table. Null when the flag is off or the run is not in the project. */
export async function loadRunPage(
  projectId: string,
  actor: string,
  runId: string,
  filter: RunFilter,
  deps: PageDeps = {},
): Promise<RunPageModel | null> {
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
  const store = createDrizzleEvalStore(db);
  const run = UUID.test(runId) ? await store.getRun(projectId, runId) : null;
  if (!run) return null;
  const results = await store.listResults(projectId, run.id);
  const evals = await evalsById(
    projectId,
    results.map((result) => result.evalId),
    db,
  );
  const names = await taskNames(projectId, [...new Set(evals.flatMap((item) => item.tasks))], db);
  const previous =
    (await store.listRuns(projectId, { limit: RUN_LIST_LIMIT })).find(
      (other) =>
        other.status === "completed" &&
        other.kind !== "simulation" &&
        other.createdAt < run.createdAt,
    ) ?? null;
  if (run.kind === "simulation") {
    // RC-294: two sides per eval, read once each against today.
    const rows = simulationRowsOf(results);
    const { passed, total, broke, fixed } = tallySimulation(rows);
    return {
      run,
      table: simulationTable(rows, evals, names, filter),
      summary: { passed, total, nowFails: broke, fixed },
      previous,
    };
  }
  return {
    run,
    table: runTable(results, evals, names, filter),
    summary: runSummary(results),
    previous,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Import and suggest (for every task, or the given ones), once per open. A failure costs the page nothing: the set reads as it was. */
async function fillEvalSet(
  projectId: string,
  deps: SuggestDeps & { db: ReturnType<typeof getDb> },
  only?: readonly string[],
): Promise<void> {
  try {
    await importTaskCases(projectId, deps);
    const tasks = only ?? (await tasksToFill(projectId, deps.db));
    for (const taskId of tasks) await suggestTaskEvals(projectId, taskId, deps);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "eval set fill failed");
  }
}

/** Every task with cases, and (RC-616) every task with its own scorers: score-based suggestions need no case. */
async function tasksToFill(projectId: string, db: ReturnType<typeof getDb>): Promise<string[]> {
  const withCases = await db
    .selectDistinct({ taskId: taskEvalCases.taskId })
    .from(taskEvalCases)
    .where(eq(taskEvalCases.projectId, projectId));
  const withScorers = await db
    .selectDistinct({ taskId: scorersTable.taskId })
    .from(scorersTable)
    .where(and(eq(scorersTable.projectId, projectId), isNotNull(scorersTable.taskId)));
  return [
    ...new Set([...withCases, ...withScorers].flatMap((row) => (row.taskId ? [row.taskId] : []))),
  ];
}

async function evalsById(
  projectId: string,
  ids: readonly string[],
  db: ReturnType<typeof getDb>,
): Promise<Eval[]> {
  const wanted = new Set(ids);
  return (await createDrizzleEvalStore(db).listEvals(projectId)).filter((item) =>
    wanted.has(item.id),
  );
}

/**
 * A name for each task (RC-316): its newest label, else "Untitled task" and the
 * first words of the most common ask of its evals. Never the raw id.
 */
export async function taskNames(
  projectId: string,
  taskIds: readonly string[],
  db: ReturnType<typeof getDb> = getDb(),
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ workflowId: traceWorkflowLabels.workflowId, name: traceWorkflowLabels.name })
    .from(traceWorkflowLabels)
    .where(
      and(
        eq(traceWorkflowLabels.projectId, projectId),
        inArray(traceWorkflowLabels.workflowId, [...taskIds]),
      ),
    )
    .orderBy(desc(traceWorkflowLabels.updatedAt));
  const labels = new Map<string, string>();
  for (const row of rows)
    if (!labels.has(row.workflowId) && row.name.trim()) labels.set(row.workflowId, row.name);
  const unlabelled = taskIds.filter((id) => !labels.has(id));
  const asks = new Map<string, string[]>();
  if (unlabelled.length > 0) {
    const messages = await db
      .select({ workflowId: evalTasks.workflowId, message: evalsTable.message })
      .from(evalTasks)
      .innerJoin(evalsTable, eq(evalsTable.id, evalTasks.evalId))
      .where(and(eq(evalsTable.projectId, projectId), inArray(evalTasks.workflowId, unlabelled)));
    for (const { workflowId, message } of messages)
      asks.set(workflowId, [...(asks.get(workflowId) ?? []), message]);
  }
  return new Map(taskIds.map((id) => [id, taskDisplayName(labels.get(id), asks.get(id) ?? [])]));
}

export interface EvalPageModel {
  item: Eval;
  tasks: TaskTag[];
  rules: RuleWithSource[];
  /** The run shown: the one asked for, else the eval's newest completed run. */
  run: EvalRun | null;
  result: EvalResult | null;
  /** "17 of 20" in the run's table, only when a run was asked for. */
  position: { index: number; total: number; prev: string | null; next: string | null } | null;
  runCount: number;
  /** The session page of the recorded run ("Open the full replay"). */
  replayHref: string | null;
  /** RC-642: this eval's completed result before the shown run, for "Runs differ from here". */
  previous: { run: EvalRun; result: EvalResult } | null;
  /** RC-642: the run asked for, while it is queued or running (it has no result yet). */
  pending: EvalRun | null;
}

const EVAL_RUNS_LIMIT = 50;

/** One eval at one run (the Last run tab, F1). Null when the flag is off or the eval is not in the project. */
export async function loadEvalPage(
  projectId: string,
  actor: string,
  evalId: string,
  runId: string | null,
  deps: PageDeps = {},
): Promise<EvalPageModel | null> {
  const base = await evalBase(projectId, actor, evalId, deps);
  if (!base) return null;
  const { db, store, item, tasks, rules } = base;
  const history = await store.resultsForEval(projectId, item.id, EVAL_RUNS_LIMIT);
  const picked = runId
    ? (history.find((entry) => entry.run.id === runId) ?? null)
    : (history.find((entry) => entry.run.status === "completed") ?? null);
  let position: EvalPageModel["position"] = null;
  if (runId && picked) {
    const results = await store.listResults(projectId, picked.run.id);
    const evals = await evalsById(
      projectId,
      results.map((result) => result.evalId),
      db,
    );
    position = neighbours(
      runTable(results, evals, new Map(), "all").rows.map((row) => row.evalId),
      item.id,
    );
  }
  const pickedAt = picked ? history.indexOf(picked) : -1;
  const previous = picked
    ? (history.slice(pickedAt + 1).find((entry) => entry.run.status === "completed") ?? null)
    : null;
  const asked =
    runId && !picked && /^[0-9a-f-]{36}$/i.test(runId)
      ? await store.getRun(projectId, runId)
      : null;
  const pending = asked && (asked.status === "queued" || asked.status === "running") ? asked : null;
  return {
    item,
    tasks,
    rules,
    run: picked?.run ?? null,
    result: picked?.result ?? null,
    position,
    previous,
    pending,
    runCount: history.length,
    replayHref: item.sourceTurnId
      ? `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(item.sourceTurnId)}`
      : null,
  };
}

/** One eval's runs (the Runs tab, D2): newest first. */
export async function loadEvalRunsPage(
  projectId: string,
  actor: string,
  evalId: string,
  deps: PageDeps = {},
) {
  const base = await evalBase(projectId, actor, evalId, deps);
  if (!base) return null;
  const history = await base.store.resultsForEval(projectId, base.item.id, EVAL_RUNS_LIMIT);
  return { item: base.item, history, runCount: history.length };
}

/** The Definition tab (D3): what the eval is, without results. */
export async function loadEvalDefinition(
  projectId: string,
  actor: string,
  evalId: string,
  deps: PageDeps = {},
) {
  const base = await evalBase(projectId, actor, evalId, deps);
  if (!base) return null;
  const runCount = (await base.store.resultsForEval(projectId, base.item.id, EVAL_RUNS_LIMIT))
    .length;
  return { item: base.item, tasks: base.tasks, rules: base.rules, runCount };
}

async function evalBase(projectId: string, actor: string, evalId: string, deps: PageDeps) {
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
  const store = createDrizzleEvalStore(db);
  const item = UUID.test(evalId) ? await store.getEval(projectId, evalId) : null;
  if (!item) return null;
  const names = await taskNames(projectId, item.tasks, db);
  const scorers = await enabledTaskScorers(projectId, item.tasks, db);
  return {
    db,
    store,
    item,
    tasks: item.tasks.map((id) => taskTag(id, names)),
    rules: evalRules(
      item.tasks.map((id) => scorers.get(id) ?? []),
      item,
    ),
  };
}
