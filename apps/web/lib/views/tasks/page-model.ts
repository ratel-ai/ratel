import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import type { Organization } from "@/lib/platform/identity/schema";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { loadWorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide-queries";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { loadFixes } from "@/lib/views/fixes/load";
import { fixSeams } from "@/lib/views/fixes/seams";
import type { FixesModel } from "@/lib/views/fixes/types";
import type { TaskFixLike } from "@/lib/views/tasks/issues";
import type { TaskDetailModel, TaskFixSource, TasksInputs } from "@/lib/views/tasks/model";
import {
  type ExampleRun,
  issueSources,
  type LatestTasksRun,
  loadExampleRuns,
  loadLatestTasksRun,
  loadTaskCorrections,
  loadTaskTopics,
} from "@/lib/views/tasks/queries";
import { tasksSeams } from "@/lib/views/tasks/seams";

/**
 * Everything the task pages read, each read bounded by a statement timeout
 * and degrading on its own: without the latest run there is no reading to
 * show; without names, issues, fixes, topics or self-corrections the page
 * still shows its tasks, with those parts marked as not measured. Every
 * failure is logged and reported before its fallback is used.
 *
 * Owned (ADR-0030): the tool crafter's drafted changes and its round-trip
 * price come through `tasksSeams` and `fixSeams` once it lands.
 */

export interface TasksLoadDeps {
  read: <T>(
    operation: string,
    read: (db: BoundReadDb) => Promise<T>,
    supplementary?: boolean,
  ) => Promise<T>;
  latestRun: (projectId: string, db: BoundReadDb) => Promise<LatestTasksRun | null>;
}

const defaultDeps: TasksLoadDeps = {
  read: (operation, read, supplementary = false) =>
    withStatementTimeout(read, {
      operation,
      ...(supplementary ? { timeoutMs: supplementaryReadTimeoutMs() } : {}),
    }),
  latestRun: (projectId, db) => loadLatestTasksRun(projectId, db),
};

function fallback<T>(
  projectId: string,
  operation: string,
  value: T,
  load: () => Promise<T>,
): Promise<T> {
  return loadOrFallback({ operation, distinctId: `project:${projectId}`, fallback: value, load });
}

export async function loadTasksInputs(
  projectId: string,
  overrides: Partial<TasksLoadDeps> = {},
): Promise<TasksInputs> {
  const deps = { ...defaultDeps, ...overrides };
  const run = await fallback(projectId, "tasks_latest_run", null as LatestTasksRun | null, () =>
    deps.read("tasks_latest_run", (db) => deps.latestRun(projectId, db)),
  );
  const empty: TasksInputs = {
    projectId,
    run: null,
    stored: null,
    labels: new Map(),
    names: new Map(),
    issues: [],
    insights: null,
    fixes: [],
    recorded: null,
    topics: null,
    price: null,
  };
  if (!run) return empty;
  const since = run.windowStart;
  const read = <T>(operation: string, value: T, load: (db: BoundReadDb) => Promise<T>) =>
    fallback(projectId, operation, value, () => deps.read(operation, load, true));
  const [labels, names, signalRows, insights, recorded, topics] = await Promise.all([
    read("tasks_labels", new Map() as Awaited<ReturnType<typeof loadWorkflowLabels>>, (db) =>
      loadWorkflowLabels(projectId, db),
    ),
    read("tasks_catalog_names", new Map<string, string>(), (db) => loadCatalogNames(projectId, db)),
    read("tasks_open_issues", [] as Awaited<ReturnType<typeof listOpenSignals>>, (db) =>
      listOpenSignals(projectId, db),
    ),
    read("tasks_insights", null as Awaited<ReturnType<typeof loadWorkflowInsights>>, (db) =>
      loadWorkflowInsights(projectId, db),
    ),
    read("tasks_self_corrections", null as Awaited<ReturnType<typeof loadTaskCorrections>>, (db) =>
      loadTaskCorrections(projectId, since, db),
    ),
    read("tasks_topics", null as Awaited<ReturnType<typeof loadTaskTopics>>, (db) =>
      loadTaskTopics(projectId, since, db),
    ),
  ]);
  // The tool crafter's drafted changes, once it lands (`tasksSeams`); none until then.
  const drafts = tasksSeams.loadDrafts;
  const fixes = drafts
    ? await read("tasks_pending_fixes", [] as TaskFixSource[], (db) => drafts(projectId, db, names))
    : [];
  return {
    projectId,
    run: { windowDays: run.windowDays, finishedAt: run.finishedAt, turnsScanned: run.turnsScanned },
    stored: run.workflows,
    labels,
    names,
    issues: issueSources(signalRows),
    insights: insights?.data ?? null,
    fixes,
    recorded,
    topics,
    price: fixSeams.priceOf && Array.isArray(run.daily) ? fixSeams.priceOf(run.daily) : null,
  };
}

/** A task page's example runs, read when the page shows them; a failed read shows the runs without them. */
export async function loadTaskExamples(
  projectId: string,
  detail: Pick<TaskDetailModel, "examples">,
  overrides: Partial<TasksLoadDeps> = {},
  names: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ExampleRun>> {
  const deps = { ...defaultDeps, ...overrides };
  return fallback(projectId, "task_example_runs", new Map<string, ExampleRun>(), () =>
    deps.read(
      "task_example_runs",
      (db) =>
        loadExampleRuns(
          projectId,
          detail.examples.map((example) => example.turnId),
          db,
          names,
        ),
      true,
    ),
  );
}

/**
 * Fixes' open fixes (its one model, `loadFixes`), so a task counts and lists
 * the fixes its link lands on. Null when they could not be read: the task
 * pages then fall back to the drafts on the task's tools.
 */
export async function loadTaskFixes(
  projectId: string,
  organization: Organization,
  load: (input: {
    projectId: string;
    organization: Organization;
    topics: false;
  }) => Promise<Pick<FixesModel, "open">> = loadFixes,
): Promise<readonly TaskFixLike[] | null> {
  return fallback(
    projectId,
    "tasks_fixes",
    null as readonly TaskFixLike[] | null,
    async () => (await load({ projectId, organization, topics: false })).open,
  );
}
