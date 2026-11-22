import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { loadProjectFixes } from "@/lib/mcp/operations/loop/read";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { type FixContext, loadFixContext } from "@/lib/views/eval-gate/service";
import { findFix } from "@/lib/views/fixes/select";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { changeTaskEval } from "@/lib/views/task-evals/actions";
import { draftTaskTest } from "@/lib/views/task-evals/draft-action";
import { enqueueTaskEvalRefreshJob } from "@/lib/views/task-evals/job";
import { draftTestFromRun, TestDraftError } from "@/lib/views/task-evals/run-to-test";
import type { TaskEvalCaseRow } from "@/lib/views/task-evals/schema";
import { changeTaskSimulation } from "@/lib/views/task-evals/simulation-actions";
import {
  type TaskSimulationDetail,
  taskSimulationDetailFor,
  taskSimulationListFor,
} from "@/lib/views/task-evals/simulation-page";
import { taskEvalSetFor } from "@/lib/views/task-evals/store";
import { type TestProposal, testProposalSchema } from "@/lib/views/task-evals/test-proposal";
import { changeTaskScorer } from "@/lib/views/task-scorers/actions";
import { resetScorer, upsertScorer } from "@/lib/views/task-scorers/store";
import { SCORER_KINDS } from "@/lib/views/task-scorers/types";
import {
  buildTaskDetail,
  buildTaskList,
  type TaskDetailModel,
  type TaskListModel,
  type TaskRow,
} from "@/lib/views/tasks/model";
import { loadTaskExamples, loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";
import type { ExampleRun } from "@/lib/views/tasks/queries";

/**
 * A task's scorers, eval set, tests and simulations as tools: what the Task
 * page and its Simulations tab let a person change, through the same
 * `lib/task-*` entry points the console's server actions call. Those entry
 * points take a session; here the MCP caller stands in for it (`mcpActor`), and
 * the project is the one dispatch already authorized.
 *
 * Gated as the console gates them: scoring only with `cloud-eval-gate`,
 * decided for the caller in the project's organization. Off, the tool refuses
 * with `forbidden` and the reason.
 */

/* - Shared with eval-sets.ts ------------------------------------------------ */

/** Who acted, as stored rows and events name them: `project:<id>` for an API key, else the Clerk id. */
export function mcpActor(auth: McpAuthContext, projectId: string): string {
  return auth.kind === "api-key" ? `project:${projectId}` : auth.externalUserId;
}

export function mcpEventContext(ctx: OperationContext) {
  const orgId = ctx.organizationId ? { orgId: ctx.organizationId } : {};
  return ctx.auth.kind === "api-key"
    ? { projectId: ctx.projectId, ...orgId }
    : { externalId: ctx.auth.externalUserId, projectId: ctx.projectId, ...orgId };
}

/**
 * The session and scope a `lib/task-*` action asks for, answered for the MCP
 * caller: dispatch has already resolved the project and the caller's access to
 * it, so any other project is refused.
 */
export function mcpSessionDeps(ctx: OperationContext, actor: string) {
  return {
    getSession: async () => ({ user: { id: actor, externalId: actor } }),
    findProjectScope: async (projectId: string) =>
      projectId === ctx.projectId
        ? { project: { id: ctx.projectId }, organization: { id: ctx.organizationId ?? "" } }
        : null,
  };
}

/** A refusal a `lib/*` action returned (`{ ok: false, error }`), as the tool's error. */
export function libRefusal(message: string): McpOperationError {
  if (/invalid/i.test(message)) return invalidParams(message);
  if (/^No |does not belong|no longer in|isn't open/i.test(message))
    return new McpOperationError("not_found", message);
  return new McpOperationError("conflict", message);
}

export function evalGateOff(): McpOperationError {
  return new McpOperationError("forbidden", EVAL_GATE_OFF_ERROR, { reason: "eval_gate_off" });
}

/* - Reads behind list_tasks and get_task ------------------------------------ */

/** One task as its page reads it: the list's row, the detail and the example runs. */
export interface TaskPageRead {
  row: TaskRow;
  detail: TaskDetailModel;
  examples: ReadonlyMap<string, ExampleRun>;
}

/** The project's open fixes as the task pages read them; null when unread (counts then fall back to drafts). */
async function taskFixesFor(projectId: string) {
  const organization = await getOrganizationByProjectId(projectId);
  return organization ? loadTaskFixes(projectId, organization) : null;
}

/** The Tasks page's model: `buildTaskList` with Fixes' open fixes, so fix counts match the page. */
export async function loadTaskListModel(projectId: string): Promise<TaskListModel> {
  const [inputs, fixes] = await Promise.all([loadTasksInputs(projectId), taskFixesFor(projectId)]);
  return buildTaskList(inputs, { fixes });
}

/** The Task page's reads for one task; null when the latest reading has no such task. */
export async function loadTaskPage(
  projectId: string,
  taskId: string,
): Promise<TaskPageRead | null> {
  const [inputs, fixes] = await Promise.all([loadTasksInputs(projectId), taskFixesFor(projectId)]);
  const detail = buildTaskDetail(inputs, taskId, { fixes });
  const row = detail
    ? buildTaskList(inputs, { fixes }).rows.find((candidate) => candidate.id === taskId)
    : undefined;
  if (!detail || !row) return null;
  return { row, detail, examples: await loadTaskExamples(projectId, detail, {}, inputs.names) };
}

/** The Tasks page as list_tasks returns it: a page of rows, the reading's totals and the asks no task serves. */
export function taskListView(
  projectId: string,
  model: TaskListModel,
  limit: number,
  tracker: TruncationTracker,
) {
  return {
    count: model.rows.length,
    tasks: tracker
      .take(capRows(model.rows, limit))
      .map((task) => ({ ...task, href: topLevelTasksHref(projectId, task.id) })),
    state: model.state,
    blocked: model.blocked,
    windowDays: model.windowDays,
    readAt: model.readAt?.toISOString() ?? null,
    stats: model.stats,
    unserved: {
      measured: model.unserved.measured,
      runs: model.unserved.runs,
      asks: tracker.take(capRows(model.unserved.asks, 10)).map((ask) => ({
        title: tracker.text(ask.title, 200),
        runs: ask.runs,
        reason: ask.reason ?? null,
        others: ask.others.length,
      })),
    },
    readingSince: model.readingSince,
    excludedRuns: model.excludedRuns,
  };
}

const STEP_CAP = 20;
const NEXT_CAP = 5;

function stepsView(steps: TaskDetailModel["steps"], tracker: TruncationTracker) {
  return tracker
    .take(capRows(steps, STEP_CAP))
    .map((step) => ({ ...step, next: tracker.take(capRows(step.next, NEXT_CAP)) }));
}

/** What the Task page shows besides the list's row, capped for a context window. */
export function taskDetailView(read: TaskPageRead, tracker: TruncationTracker) {
  const { detail, examples } = read;
  return {
    statusLine: detail.statusLine,
    watch: detail.watch,
    windowDays: detail.windowDays,
    readAt: detail.readAt?.toISOString() ?? null,
    finishedRuns: detail.finishedRuns,
    askedNoTool: detail.askedNoTool,
    recoveredRuns: detail.recoveredRuns,
    medianMs: detail.medianMs,
    callsPerRun: detail.callsPerRun,
    cost: detail.cost,
    hasReading: detail.hasReading,
    order: detail.order,
    steps: stepsView(detail.steps, tracker),
    sideSteps: stepsView(detail.sideSteps, tracker),
    flow: {
      edges: tracker.take(capRows(detail.flow.edges, 40)),
      tools: tracker.take(capRows(detail.flow.tools, STEP_CAP)),
    },
    intents: detail.topics ? tracker.take(capRows(detail.topics, 10)) : null,
    corrections: detail.corrections,
    issueList: tracker.take(capRows(detail.issues, 20)).map((issue) => ({
      id: issue.id,
      kind: issue.kind,
      title: issue.title,
      figure: issue.figure,
      onTask: issue.onTask,
      claim: tracker.text(issue.claim, 400),
      whatToDo: tracker.text(issue.fix, 400),
      tools: issue.tools,
    })),
    fixList: tracker.take(capRows(detail.fixes, 20)),
    allFixesHref: detail.allFixesHref,
    exampleRuns: detail.examples.map((example) => {
      const run = examples.get(example.turnId);
      return {
        runId: example.turnId,
        why: example.why,
        status: run?.status ?? null,
        startedAt: run?.startedAt.toISOString() ?? null,
        calls: run?.calls ?? null,
        failures: run?.failures ?? null,
        ask: run?.ask ? tracker.text(run.ask.text, 200) : null,
      };
    }),
  };
}

/* - The task tools ---------------------------------------------------------- */

export interface TaskOperationDeps {
  evalGateEnabled: (projectId: string, actor: string) => Promise<boolean>;
  /** Fixes open and applied, as the Simulations tab lists them. */
  loadProjectFixes: (projectId: string) => Promise<FixesModel | null>;
  taskSimulationListFor: (
    projectId: string,
    taskId: string,
    fixes: readonly Fix[],
  ) => ReturnType<typeof taskSimulationListFor>;
  taskSimulationDetailFor: (
    projectId: string,
    taskId: string,
    fix: Fix,
  ) => Promise<TaskSimulationDetail>;
  /** A task's cases, excluded ones included, for `restore` by case id. */
  taskEvalCases: (projectId: string, taskId: string) => Promise<TaskEvalCaseRow[]>;
  changeTaskScorer: typeof changeTaskScorer;
  saveScorer: typeof upsertScorer;
  resetScorer: typeof resetScorer;
  changeTaskEval: typeof changeTaskEval;
  enqueueTaskEvalRefresh: (projectId: string, taskId: string) => Promise<{ id: string } | null>;
  draftTaskTest: typeof draftTaskTest;
  draftTestFromRun: (
    projectId: string,
    taskId: string,
    turnId: string,
    actor: string,
  ) => Promise<TestProposal>;
  changeTaskSimulation: typeof changeTaskSimulation;
  loadFixContext: (projectId: string, fixId: string) => Promise<FixContext | null>;
  trackServerEvent: typeof trackServerEvent;
}

export const defaultTaskDeps: TaskOperationDeps = {
  evalGateEnabled: (projectId, actor) => evalGateEnabledForActor(projectId, actor),
  loadProjectFixes,
  taskSimulationListFor: (projectId, taskId, fixes) =>
    taskSimulationListFor(projectId, taskId, fixes),
  taskSimulationDetailFor: (projectId, taskId, fix) =>
    taskSimulationDetailFor(projectId, taskId, fix),
  taskEvalCases: async (projectId, taskId) => (await taskEvalSetFor(projectId, taskId)).cases,
  changeTaskScorer,
  saveScorer: (input) => upsertScorer(input),
  resetScorer: (projectId, taskId, kind) => resetScorer(projectId, taskId, kind),
  changeTaskEval,
  enqueueTaskEvalRefresh: (projectId, taskId) => enqueueTaskEvalRefreshJob(projectId, taskId),
  draftTaskTest,
  draftTestFromRun: (projectId, taskId, turnId, actor) =>
    draftTestFromRun(projectId, taskId, turnId, { actor }),
  changeTaskSimulation,
  loadFixContext,
  trackServerEvent,
};

/**
 * The task tools' gate for this caller (RC-46): the eval gate. The `lib/task-*`
 * actions are then told the answer rather than deciding it a second time.
 */
async function requireTaskGates(deps: TaskOperationDeps, ctx: OperationContext): Promise<string> {
  const actor = mcpActor(ctx.auth, ctx.projectId);
  if (!(await deps.evalGateEnabled(ctx.projectId, actor))) throw evalGateOff();
  return actor;
}

const decided = async () => true;

async function track(
  deps: TaskOperationDeps,
  ctx: OperationContext,
  event: Parameters<typeof trackServerEvent>[0],
  fields: object,
) {
  await deps.trackServerEvent(event, mcpEventContext(ctx), {
    ...fields,
    object_action: event,
    surface: "mcp",
  });
}

const taskIdParam = z.string().trim().min(1).max(500).describe("A task id from list_tasks.");
const fixIdParam = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("A fix id from list_fixes, e.g. craft:<uuid>.");
const caseIdParam = uuidParam().describe(
  "A case id from get_task (evalSet.rows) or list_task_simulations.",
);
const runIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("A run id: a turn id from get_task's exampleRuns or a trace.");

function simulationHref(projectId: string, taskId: string, fixId: string): string {
  return `${topLevelTasksHref(projectId, taskId)}/simulations/${encodeURIComponent(fixId)}`;
}

/** A fix test's expected outcome, as `parseExpected` keeps it: whole numbers, trimmed names. */
const testExpectedSchema = z
  .object({
    tool: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullable()
      .optional()
      .describe("The tool the run should call."),
    maxToolCalls: z.number().int().nonnegative().nullable().optional(),
    maxSearches: z.number().int().nonnegative().nullable().optional(),
    maxFailedCalls: z.number().int().nonnegative().nullable().optional(),
    avoidTools: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    endsWell: z.boolean().nullable().optional(),
    maxSelfCorrections: z.number().int().nonnegative().nullable().optional(),
    maxCostUsd: z.number().finite().nonnegative().nullable().optional(),
    maxLatencyMs: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

/** Only the fields given, so the action's strict check compares like with like. */
function givenExpected(expected: z.infer<typeof testExpectedSchema>): Record<string, unknown> {
  const given = Object.entries(expected).filter(([, value]) => value !== undefined);
  return Object.fromEntries(
    given.map(([key, value]) => [
      key,
      key === "avoidTools" ? [...new Set(value as string[])] : value,
    ]),
  );
}

function simulationDetailView(detail: TaskSimulationDetail, tracker: TruncationTracker) {
  return {
    fixId: detail.fixId,
    title: detail.title,
    change: detail.change,
    draftStatus: detail.draftStatus,
    tools: detail.tools,
    state: detail.state.state,
    stale: detail.state.stale,
    fixTests: tracker.take(capRows(detail.fixCases, 20)).map((item) => ({
      caseId: item.id,
      runId: item.turnId,
      ask: tracker.text(item.ask, 300),
      expected: item.expected,
      criteria: tracker.text(item.criteria, 1_000),
      runHref: item.runHref,
    })),
    taskTestCount: detail.taskCases.length,
    taskTests: tracker.take(capRows(detail.taskCases, 20)).map((row) => ({
      caseId: row.id,
      runId: row.turnId,
      origin: row.origin,
      pinned: row.pinned,
      name: row.name ?? null,
      ask: tracker.text(row.ask, 300),
    })),
    replayedRuns: tracker.take(capRows(detail.replayRuns, 10)),
    runs: tracker.take(capRows(detail.runs, 10)),
    shipments: tracker
      .take(capRows(detail.shipments, 10))
      .map((shipment) => ({ ...shipment, notes: tracker.text(shipment.notes, 300) })),
  };
}

export function loopTaskReadOperations(deps: TaskOperationDeps = defaultTaskDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_task_simulations",
      domain: "improvement",
      title: "List a task's simulations",
      description:
        "Each fix's latest simulation on one task: state (better, worse, same, running, none) and whether it is stale after an edit. Pass fixId for one simulation's change, draft status, fix tests, task tests, replayed runs and runs. Edit with change_task_simulation; run it with run_eval.",
      keywords: ["task simulations", "simulation stale", "fix tests"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam,
        fixId: fixIdParam.optional(),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        await requireTaskGates(deps, ctx);
        const model = await deps.loadProjectFixes(ctx.projectId);
        if (!model) throw notFound("project");
        const fixes = [...model.open, ...model.applied];
        const tracker = new TruncationTracker();
        if (params.fixId) {
          const fix = findFix(fixes, params.fixId);
          if (!fix || !fix.subject.tasks.some((task) => task.id === params.taskId))
            throw notFound("fix for this task");
          const detail = await deps.taskSimulationDetailFor(ctx.projectId, params.taskId, fix);
          return {
            data: {
              simulation: {
                ...simulationDetailView(detail, tracker),
                href: simulationHref(ctx.projectId, params.taskId, fix.id),
              },
            },
            truncated: tracker.value,
            hint:
              detail.state.stale || detail.state.state === "none"
                ? "run_eval with this fixId simulates it on the current draft, tests and scorers."
                : "change_task_simulation edits the draft or a test; mark_fix_shipped once it is live.",
          };
        }
        const rows = await deps.taskSimulationListFor(ctx.projectId, params.taskId, fixes);
        return {
          data: {
            count: rows.length,
            simulations: tracker.take(capRows(rows, params.limit)).map((row) => ({
              ...row,
              why: tracker.text(row.why, 300),
              href: simulationHref(ctx.projectId, params.taskId, row.fixId),
            })),
          },
          truncated: tracker.value,
          hint:
            rows.length === 0
              ? "No fix touches this task. list_fixes with taskId shows the task's fixes."
              : "Pass fixId for one simulation's detail. A stale or never-run simulation needs run_eval.",
        };
      },
    }),
  ];
}

export function loopTaskWriteOperations(deps: TaskOperationDeps = defaultTaskDeps): McpOperation[] {
  return [
    defineOperation({
      id: "change_task_scorer",
      domain: "writes",
      title: "Change a task scorer",
      description:
        "Turn one of a task's scorers on or off with its setting, or reset it to the default. max_* kinds need max, expected_tool needs tool, judge_criteria needs criteria. Returns the saved scorer. Read scorers with get_task.",
      keywords: ["task scorer", "judge criteria", "expected tool scorer"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam,
        kind: z.enum(SCORER_KINDS),
        action: z
          .enum(["save", "reset"])
          .default("save")
          .describe("reset returns the scorer to its default."),
        enabled: z.boolean().optional().describe("Required to save: on or off."),
        max: z
          .number()
          .finite()
          .nonnegative()
          .optional()
          .describe(
            "The limit for max_* kinds; a whole number for max_tool_calls and max_self_corrections.",
          ),
        tool: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe("The tool id expected_tool checks for."),
        criteria: z
          .string()
          .trim()
          .min(1)
          .max(5_000)
          .optional()
          .describe("What judge_criteria asks a judge model to check."),
      }),
      async execute(ctx, params) {
        if (params.action === "save" && params.enabled === undefined)
          throw invalidParams("Pass enabled to save a scorer.");
        const actor = await requireTaskGates(deps, ctx);
        const base = { projectId: ctx.projectId, taskId: params.taskId };
        const input =
          params.action === "reset"
            ? { ...base, action: "reset", kind: params.kind }
            : {
                ...base,
                action: "save",
                enabled: params.enabled,
                scorer: {
                  kind: params.kind,
                  max: params.max,
                  tool: params.tool,
                  criteria: params.criteria,
                },
              };
        const result = await deps.changeTaskScorer(input, {
          ...mcpSessionDeps(ctx, actor),
          enabled: decided,
          save: deps.saveScorer,
          reset: deps.resetScorer,
          observe: (fields) => track(deps, ctx, "task_scorer_updated", fields),
        });
        if (!result.ok) {
          throw result.error === "The scorer settings are invalid."
            ? invalidParams(
                `${result.error} ${params.kind.startsWith("max_") ? "Pass max." : params.kind === "expected_tool" ? "Pass tool." : params.kind === "judge_criteria" ? "Pass criteria." : ""}`.trim(),
              )
            : libRefusal(result.error);
        }
        return {
          data: {
            taskId: params.taskId,
            kind: params.kind,
            action: params.action,
            ...(params.action === "save" ? { enabled: params.enabled } : {}),
          },
          hint: "get_task shows the task's scorers; run_eval re-simulates a fix with them.",
        };
      },
    }),
    defineOperation({
      id: "change_task_eval_set",
      domain: "writes",
      title: "Change a task's eval set",
      description:
        "Edit the runs a task's fixes are tested on: pin, unpin or exclude a case (caseId), add a run (runId, with an optional proposal from draft_task_test to save it as a test), restore an excluded run (caseId or runId), or refresh the set (returns jobId for get_job_status).",
      keywords: ["edit task eval set", "pin a run", "exclude a run", "save a test"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam,
        action: z.enum(["pin", "unpin", "exclude", "add", "restore", "refresh"]),
        caseId: caseIdParam.optional(),
        runId: runIdParam.optional(),
        proposal: testProposalSchema
          .optional()
          .describe("A test from draft_task_test, edited or not; only with add."),
      }),
      async execute(ctx, params) {
        const input = taskEvalInput(ctx, params);
        const actor = await requireTaskGates(deps, ctx);
        const resolved =
          params.action === "restore" ? await restoreInput(deps, ctx, params, input) : input;
        const result = await deps.changeTaskEval(resolved, {
          ...mcpSessionDeps(ctx, actor),
          enabled: decided,
          enqueue: deps.enqueueTaskEvalRefresh,
          observe: async (fields) => {
            await track(deps, ctx, "task_eval_case_changed", fields);
            if (fields.test_saved) await track(deps, ctx, "task_test_saved", fields);
          },
          observeRefusal: (fields) => track(deps, ctx, "task_eval_run_refused", fields),
        });
        if (!result.ok) throw libRefusal(result.error);
        return {
          data: {
            taskId: params.taskId,
            action: params.action,
            message: result.message,
            ...(result.jobId ? { jobId: result.jobId } : {}),
          },
          hint: result.jobId
            ? "Poll get_job_status with this jobId, then read get_task's evalSet."
            : "get_task shows the task's eval set.",
        };
      },
    }),
    defineOperation({
      id: "draft_task_test",
      domain: "writes",
      title: "Draft a task test from a run",
      description:
        "Ask a model to draft a test from one completed run of a task: a name, the ask, the expected outcome and criteria. Spends model budget; saves nothing. Save it with change_task_eval_set action add, this runId and the proposal.",
      keywords: ["draft a test", "test from a run"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam,
        runId: uuidParam().describe(
          "A completed run (turn id) of this task, from get_task's exampleRuns.",
        ),
      }),
      async execute(ctx, params) {
        const actor = await requireTaskGates(deps, ctx);
        let result: Awaited<ReturnType<typeof draftTaskTest>>;
        try {
          result = await deps.draftTaskTest(
            { projectId: ctx.projectId, taskId: params.taskId, turnId: params.runId },
            {
              ...mcpSessionDeps(ctx, actor),
              enabled: decided,
              draft: (projectId, taskId, turnId, by) =>
                deps.draftTestFromRun(projectId, taskId, turnId, by),
            },
          );
        } catch (err) {
          if (err instanceof TestDraftError)
            throw err.message === EVAL_GATE_OFF_ERROR ? evalGateOff() : libRefusal(err.message);
          throw err;
        }
        if (!result.ok) throw libRefusal(result.error);
        await track(deps, ctx, "task_test_drafted", {
          project_id: ctx.projectId,
          task_id: params.taskId,
          turn_id: params.runId,
          actor,
        });
        return {
          data: { taskId: params.taskId, runId: params.runId, proposal: result.proposal },
          hint: "Nothing is saved yet. change_task_eval_set with action add, this runId and the proposal saves it as a test.",
        };
      },
    }),
    defineOperation({
      id: "change_task_simulation",
      domain: "writes",
      title: "Change a task simulation",
      description:
        "Edit what a fix is simulated with on one task: draft saves a hand-edited change (a FixChange, as get_fix returns it), add_test adds a run as a fix test (runId, expected, criteria), edit_test changes one (caseId). Then run_eval; mark_fix_shipped marks it live.",
      keywords: ["edit fix draft", "fix test"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam,
        fixId: fixIdParam,
        action: z.enum(["draft", "add_test", "edit_test"]),
        change: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'draft: the whole change, e.g. { version: 1, patches: { tool_id: "new description" }, hide: [], add: [], collapse: [], dedupeRetries: [], topK: null, skillSteps: [], unsupportedReason: null }.',
          ),
        runId: runIdParam.optional(),
        caseId: caseIdParam.optional(),
        expected: testExpectedSchema
          .optional()
          .describe("add_test and edit_test: what the run should do."),
        criteria: z
          .string()
          .max(10_000)
          .default("")
          .describe("add_test and edit_test: what a judge checks, in words."),
      }),
      async execute(ctx, params) {
        const input = simulationInput(ctx, params);
        const actor = await requireTaskGates(deps, ctx);
        const result = await deps.changeTaskSimulation(input, {
          ...mcpSessionDeps(ctx, actor),
          enabled: decided,
          loadFix: deps.loadFixContext,
          run: async () => {
            throw invalidParams("run_eval runs a simulation.");
          },
          observe: (fields) => track(deps, ctx, "task_simulation_edited", fields),
        });
        if (!result.ok) throw libRefusal(result.error);
        return {
          data: {
            taskId: params.taskId,
            fixId: params.fixId,
            action: params.action,
            message: result.message,
          },
          hint: "The last simulation is now stale: run_eval with this fixId simulates the change again.",
        };
      },
    }),
  ];
}

type TaskEvalParams = {
  taskId: string;
  action: "pin" | "unpin" | "exclude" | "add" | "restore" | "refresh";
  caseId?: string;
  runId?: string;
  proposal?: TestProposal;
};

/** The action's input, with what each action needs checked before any gate is read. */
function taskEvalInput(ctx: OperationContext, params: TaskEvalParams): Record<string, unknown> {
  const base = { projectId: ctx.projectId, taskId: params.taskId, action: params.action };
  if (params.proposal && params.action !== "add")
    throw invalidParams("proposal goes with action add.");
  switch (params.action) {
    case "pin":
    case "unpin":
    case "exclude":
      if (!params.caseId) throw invalidParams(`${params.action} needs caseId.`);
      return { ...base, caseId: params.caseId };
    case "add":
      if (!params.runId) throw invalidParams("add needs runId.");
      return {
        ...base,
        runId: params.runId,
        ...(params.proposal ? { proposal: params.proposal } : {}),
      };
    case "restore":
      if (!params.caseId && !params.runId) throw invalidParams("restore needs caseId or runId.");
      return base;
    case "refresh":
      return base;
  }
}

/** Restoring is adding the run again, as the console's Restore does; a case id names the run. */
async function restoreInput(
  deps: TaskOperationDeps,
  ctx: OperationContext,
  params: TaskEvalParams,
  base: Record<string, unknown>,
) {
  let runId = params.runId;
  if (params.caseId) {
    const cases = await deps.taskEvalCases(ctx.projectId, params.taskId);
    const excluded = cases.find(
      (item) => item.id === params.caseId && item.fixId === null && item.excludedAt !== null,
    );
    if (!excluded) throw notFound("excluded run with that caseId in this task's eval set");
    runId = excluded.turnId;
  }
  return { ...base, action: "add", runId };
}

type SimulationParams = {
  taskId: string;
  fixId: string;
  action: "draft" | "add_test" | "edit_test";
  change?: Record<string, unknown>;
  runId?: string;
  caseId?: string;
  expected?: z.infer<typeof testExpectedSchema>;
  criteria: string;
};

function simulationInput(ctx: OperationContext, params: SimulationParams): Record<string, unknown> {
  const base = { projectId: ctx.projectId, taskId: params.taskId, fixId: params.fixId };
  if (params.action === "draft") {
    if (!params.change) throw invalidParams("draft needs change.");
    return { ...base, action: "draft", change: params.change };
  }
  const test = { expected: givenExpected(params.expected ?? {}), criteria: params.criteria };
  if (params.action === "add_test") {
    if (!params.runId) throw invalidParams("add_test needs runId.");
    return { ...base, action: "add-test", runId: params.runId, ...test };
  }
  if (!params.caseId) throw invalidParams("edit_test needs caseId.");
  return { ...base, action: "edit-test", caseId: params.caseId, ...test };
}
