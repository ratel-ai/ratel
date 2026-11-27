import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CHECK_OPERATORS } from "@/lib/contracts/check";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  CONTENT_WITHHELD_HINT,
  defaultContentAccessDeps,
  mayReadContent,
} from "@/lib/mcp/operations/content-access";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, truncateText } from "@/lib/mcp/serialize";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getProjectById } from "@/lib/platform/projects/queries";
import { storable } from "@/lib/platform/storable";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { createTaskLinks } from "@/lib/views/evals/adapters/task-links";
import {
  type Compared as ComparedRun,
  type ComparisonResult,
  compareWithBaseline,
  type PinResult,
  pinBaseline,
  pinnedRun,
} from "@/lib/views/evals/baseline";
import { baselineDeps } from "@/lib/views/evals/baseline-deps";
import { readOnlyTools } from "@/lib/views/evals/console-deps";
import {
  approvalProblem,
  approvedVersion,
  type CaseVersion,
  caseContentSchema,
  draftVersion,
  type EvalCase,
} from "@/lib/views/evals/domain/case";
import { type CompareRefusal, type Comparison, compare } from "@/lib/views/evals/domain/compare";
import {
  currentVersion,
  type EvalDefinition,
  type EvalScorer,
  evalContentSchema,
  MAX_EVAL_NAME_CHARS,
  runProblem,
} from "@/lib/views/evals/domain/eval";
import {
  countTrials,
  type Experiment,
  MAX_TRIALS,
  type Trial,
  type TrialEvidence,
  trialsOfCase,
} from "@/lib/views/evals/domain/experiment";
import { type CaseFromTurn, caseFromTurn } from "@/lib/views/evals/domain/from-turn";
import { deltaKey } from "@/lib/views/evals/domain/suite";
import { advance, experimentDeps } from "@/lib/views/evals/experiment-deps";
import { caseCounts, trialsByCase } from "@/lib/views/evals/experiment-view";
import {
  type StartExperiment,
  type StartExperimentResult,
  startExperiment,
} from "@/lib/views/evals/experiments";
import { evalsEnabledForProject, evalsOrganizationIds } from "@/lib/views/evals/gate";
import type { Baseline } from "@/lib/views/evals/ports/baseline-store";
import type { ApproveResult, NewCase } from "@/lib/views/evals/ports/case-store";
import type { NewEval } from "@/lib/views/evals/ports/eval-store";
import { type SaveOptions, type SaveSource, saveOptions } from "@/lib/views/evals/save-target";
import { suiteTable } from "@/lib/views/evals/suite-view";
import { loadTurnContent } from "@/lib/views/evals/turn-content";
import { getRun, type SandboxRun } from "@/lib/views/sandboxes";

/**
 * The eval tools (decision `mcp-surface`): save a sandbox run as a case, approve it, start an eval
 * run (an experiment) against a sandbox version, read it, and compare it with a baseline. Ids start
 * with `evals_`: `run_eval`, `get_eval`, `get_experiment` and `create_experiment` are taken by the
 * improvement loop. They are listed only for a caller with the `evals` flag, and each call checks
 * the flag for its project again.
 *
 * An eval run takes minutes. `evals_start_run` returns its id at once, with a hint to poll
 * `evals_get_run`. Captured text (inputs, outputs, judge reasons) follows the content rule of
 * `content-access.ts`: an API key reads it only with the content permission and the project opt-in.
 */
export interface EvalsOperationDeps {
  enabled(projectId: string): Promise<boolean>;
  /** The newest first. With an eval, only its dataset. */
  listCases(projectId: string, evalId?: string): Promise<EvalCase[]>;
  /** The oldest first. */
  listEvals(projectId: string): Promise<EvalDefinition[]>;
  getEval(projectId: string, evalId: string): Promise<EvalDefinition | null>;
  /** The tasks of a turn or a trace, and the target eval of each (decision `trace-to-eval`). */
  saveOptions(projectId: string, source: SaveSource, task: string | null): Promise<SaveOptions>;
  /** A case made from a turn. Null when the turn is not there or has no input. Captured text. */
  turnCase(projectId: string, turnId: string): Promise<CaseFromTurn | null>;
  /** The pinned baseline run with its trials. Null when none is pinned. */
  pinnedRun(projectId: string): Promise<ComparedRun | null>;
  getCase(projectId: string, caseId: string): Promise<EvalCase | null>;
  createCase(input: NewCase): Promise<EvalCase | "eval_not_found">;
  getEvalByName(projectId: string, name: string): Promise<EvalDefinition | null>;
  createEval(input: NewEval): Promise<EvalDefinition | "name_taken">;
  approveCase(
    projectId: string,
    caseId: string,
    draft: { versionId: string; updatedAt: Date },
    by: { userId: string; now: Date },
  ): Promise<ApproveResult>;
  startExperiment(subject: UsageSubject, start: StartExperiment): Promise<StartExperimentResult>;
  /**
   * Drives a new eval run in this process until it closes, so an agent does not wait for the
   * sweep. The sweep still takes the steps that this process does not. It must not throw.
   */
  advance(experiment: Experiment): void;
  /** The newest first. */
  listExperiments(projectId: string, limit: number): Promise<Experiment[]>;
  getExperiment(projectId: string, experimentId: string): Promise<Experiment | null>;
  trials(experimentId: string): Promise<Trial[]>;
  trialEvidence(projectId: string, trialId: string): Promise<TrialEvidence | null>;
  caseVersion(versionId: string): Promise<CaseVersion | null>;
  getBaseline(projectId: string): Promise<Baseline | null>;
  pinBaseline(projectId: string, experimentId: string, pinnedBy: string): Promise<PinResult>;
  compareWithBaseline(projectId: string, experimentId: string): Promise<ComparisonResult>;
  getSandboxRun(projectId: string, runId: string): Promise<SandboxRun | null>;
  mayReadContent(ctx: Pick<OperationContext, "auth" | "projectId">): Promise<boolean>;
  organizationIdOf(projectId: string): Promise<string | null>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

const logger = getLogger("mcp/evals");
const LIST_LIMIT = 50;
/** How long `evals_get_run` waits for a running eval run to end. Far below the 60 s of a call. */
export const RUN_WAIT_MS = 20_000;
const POLL_MS = 2_000;
/** A run that the process drives longer than this is left to the sweep. */
const DRIVE_MS = 15 * 60_000;
const CASES_SHOWN = 100;
/** The outputs that `evals_get_run` reads, one query each. */
const OUTPUTS_SHOWN = 60;
const TEXT_CHARS = 2_000;
const INPUT_CHARS = 1_000;

const defaultDeps: EvalsOperationDeps = {
  enabled: (projectId) => evalsEnabledForProject(projectId),
  listCases: (projectId, evalId) => createDrizzleCaseStore(getDb()).list(projectId, evalId),
  listEvals: (projectId) => createDrizzleEvalStore(getDb()).list(projectId),
  getEval: (projectId, evalId) => createDrizzleEvalStore(getDb()).get(projectId, evalId),
  saveOptions: (projectId, source, task) =>
    saveOptions(projectId, source, task, {
      taskLinks: createTaskLinks(),
      evals: createDrizzleEvalStore(getDb()),
    }),
  turnCase: async (projectId, turnId) => {
    const turn = await loadTurnContent(projectId, turnId);
    return turn ? caseFromTurn(turn, await readOnlyTools(projectId)) : null;
  },
  pinnedRun: (projectId) => pinnedRun(projectId, baselineDeps()),
  getCase: (projectId, caseId) => createDrizzleCaseStore(getDb()).get(projectId, caseId),
  createCase: (input) => createDrizzleCaseStore(getDb()).create(input),
  getEvalByName: (projectId, name) => createDrizzleEvalStore(getDb()).getByName(projectId, name),
  createEval: (input) => createDrizzleEvalStore(getDb()).create(input),
  approveCase: (projectId, caseId, draft, by) =>
    createDrizzleCaseStore(getDb()).approve(projectId, caseId, draft, by),
  startExperiment: (subject, start) => startExperiment(subject, start, experimentDeps()),
  advance: (experiment) => {
    void drive(experiment).catch((error: unknown) => {
      // The sweep takes the next step of a running eval run.
      logger.warn({ err: error, experiment_id: experiment.id }, "eval run left to the sweep");
    });
  },
  listExperiments: (projectId, limit) =>
    createDrizzleExperimentStore(getDb()).list(projectId, limit),
  getExperiment: (projectId, id) => createDrizzleExperimentStore(getDb()).get(projectId, id),
  trials: (id) => createDrizzleExperimentStore(getDb()).trials(id),
  trialEvidence: (projectId, id) =>
    createDrizzleExperimentStore(getDb()).trialEvidence(projectId, id),
  caseVersion: (id) => createDrizzleExperimentStore(getDb()).caseVersion(id),
  getBaseline: (projectId) => baselineDeps().baselines.get(projectId),
  pinBaseline: (projectId, id, by) => pinBaseline(projectId, id, by, baselineDeps()),
  compareWithBaseline: (projectId, id) => compareWithBaseline(projectId, id, baselineDeps()),
  getSandboxRun: getRun,
  mayReadContent: (ctx) => mayReadContent(ctx, defaultContentAccessDeps),
  organizationIdOf: async (projectId) => (await getProjectById(projectId))?.organizationId ?? null,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const caseIdParam = uuidParam().describe("The id of a case. evals_list_cases gives the case ids.");
const runIdParam = uuidParam().describe("The id of an eval run. evals_start_run gives it.");
const evalParam = z
  .string()
  .trim()
  .min(1)
  .max(MAX_EVAL_NAME_CHARS)
  .describe("The name or the id of an eval. evals_list gives them.");

/** A scorer as an agent writes it. It becomes a check or a judge of the case. */
const scorerParam = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    name: z.string().trim().min(1).max(100),
    gating: z.boolean().default(true),
    path: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "What the check reads: output, output.<field>, tools, duration_ms, cost_usd, input_tokens, output_tokens, total_tokens or tool_arguments.<tool>.<field>.",
      ),
    op: z.enum(CHECK_OPERATORS),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }),
  z.object({
    kind: z.literal("judge"),
    name: z.string().trim().min(1).max(100),
    gating: z.boolean().default(true),
    question: z
      .string()
      .trim()
      .min(1)
      .max(5_000)
      .describe("A yes-or-no question about the answer. Yes is a pass."),
  }),
]);

export function evalsOperations(deps: EvalsOperationDeps = defaultDeps): McpOperation[] {
  return [
    defineOperation({
      id: "evals_list",
      domain: "evals",
      title: "List evals",
      description:
        "Use this tool to see the evals of the project. An eval has a dataset of cases and the scorers that score each case. It returns each eval with its id, name, task id, version number, sandbox, trials, scorer names, and the numbers of approved and draft cases.",
      keywords: ["evals", "eval definitions", "suite"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const [evals, cases] = await Promise.all([
          deps.listEvals(ctx.projectId),
          deps.listCases(ctx.projectId),
        ]);
        const byEval = Map.groupBy(cases, ({ evalId }) => evalId);
        return {
          data: {
            evals: evals.map((definition) => {
              const dataset = byEval.get(definition.id) ?? [];
              const version = currentVersion(definition);
              return {
                evalId: definition.id,
                name: definition.name,
                taskId: definition.taskId,
                version: version.number,
                sandboxName: version.sandboxName,
                trials: version.trials,
                scorers: version.scorers.map(({ name }) => name),
                approvedCases: dataset.filter((one) => approvedVersion(one)).length,
                draftCases: dataset.filter((one) => draftVersion(one)).length,
              };
            }),
          },
          hint:
            evals.length === 0
              ? "No eval yet. Call evals_create, or evals_create_case with a turnId to save a trace turn into the eval of its task."
              : "Call evals_get with an eval name for its scorers and its dataset, or evals_start_run to run the suite.",
        };
      },
    }),
    defineOperation({
      id: "evals_get",
      domain: "evals",
      title: "Read an eval",
      description:
        "Use this tool to read one eval by its name or id. It returns its newest version: the sandbox, the default params, the trials, and each scorer with its check or its judge question. It also returns the cases of its dataset with their approved and draft version numbers.",
      keywords: ["evals", "eval definition", "dataset", "scorers"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, eval: evalParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const definition = await findEval(deps, ctx.projectId, params.eval);
        if (!definition) throw notFound("eval");
        const [cases, readable] = await Promise.all([
          deps.listCases(ctx.projectId, definition.id),
          deps.mayReadContent(ctx),
        ]);
        const version = currentVersion(definition);
        const read = capRows(cases, CASES_SHOWN);
        const problem = runProblem(version);
        return {
          data: {
            evalId: definition.id,
            name: definition.name,
            taskId: definition.taskId,
            version: version.number,
            sandboxName: version.sandboxName,
            params: version.params,
            trials: version.trials,
            scorers: version.scorers.map((scorer) => evalScorerView(scorer, readable)),
            cases: read.rows.map((evalCase) => ({
              caseId: evalCase.id,
              name: evalCase.name,
              labels: evalCase.labels,
              approvedVersion: approvedVersion(evalCase)?.number ?? null,
              draftVersion: draftVersion(evalCase)?.number ?? null,
            })),
            ...(problem ? { runProblem: problem } : {}),
            ...(readable ? {} : { contentWithheld: true }),
          },
          ...(read.truncated ? { truncated: true } : {}),
          hint: problem
            ? `${problem} A run leaves this eval out until it has one.`
            : `Call evals_start_run with evals ["${definition.name}"] to run this eval alone.`,
        };
      },
    }),
    defineOperation({
      id: "evals_create",
      domain: "evals",
      title: "Create an eval",
      description:
        "Use this tool to create an eval: a name, an optional task id, a sandbox, default params, trials and scorers. This tool changes data: it adds an eval with an empty dataset. It returns the eval id and the version number. Add cases with evals_create_case.",
      keywords: ["evals", "new eval", "scorers"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        name: z.string().trim().min(1).max(MAX_EVAL_NAME_CHARS).describe("The name of the eval."),
        taskId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The task that the eval checks."),
        sandboxName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The sandbox that runs the eval. Omit it to use the sandbox of each run."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("The default params of a run. The params of a run go over them."),
        trials: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRIALS)
          .optional()
          .describe("The runs of each case."),
        scorers: z
          .array(scorerParam)
          .max(20)
          .describe("The scorers. A trial passes when every gating scorer passes."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const content = evalContentSchema.safeParse(
          storable({
            sandboxName: params.sandboxName ?? null,
            params: params.params ?? {},
            ...(params.trials ? { trials: params.trials } : {}),
            scorers: params.scorers.map(evalScorer),
          }),
        );
        if (!content.success) throw contentRefusal(content.error);
        const created = await deps.createEval({
          projectId: ctx.projectId,
          name: params.name,
          taskId: params.taskId ?? null,
          content: content.data,
          createdBy: requester(ctx.auth),
        });
        if (created === "name_taken") {
          throw new McpOperationError("conflict", "Another eval of the project has this name.", {
            reason: "name_taken",
          });
        }
        const problem = runProblem(currentVersion(created));
        return {
          data: { evalId: created.id, name: created.name, version: 1 },
          hint: problem
            ? `${problem} The eval is saved.`
            : `Call evals_create_case with eval "${created.name}" to add cases.`,
        };
      },
    }),
    defineOperation({
      id: "evals_list_cases",
      domain: "evals",
      title: "List eval cases",
      description:
        "Use this tool to see the cases of the datasets of the project, or of one eval. It returns each case with its id, name, eval id, labels, approved version number and draft version number. Only an approved case counts in an eval run.",
      keywords: ["evals", "eval cases", "dataset"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({
        ...projectScoped,
        eval: evalParam.optional().describe("Only the dataset of this eval (its name or id)."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const definition = params.eval ? await findEval(deps, ctx.projectId, params.eval) : null;
        if (params.eval && !definition) throw notFound("eval");
        const read = capRows(await deps.listCases(ctx.projectId, definition?.id), CASES_SHOWN);
        const cases = read.rows.map((evalCase) => ({
          caseId: evalCase.id,
          evalId: evalCase.evalId,
          name: evalCase.name,
          labels: evalCase.labels,
          approvedVersion: approvedVersion(evalCase)?.number ?? null,
          draftVersion: draftVersion(evalCase)?.number ?? null,
          createdAt: evalCase.createdAt.toISOString(),
        }));
        const approved = cases.filter((row) => row.approvedVersion !== null).length;
        return {
          data: { cases, approved },
          ...(read.truncated ? { truncated: true } : {}),
          hint:
            approved === 0
              ? "No case is approved. Create one with evals_create_case, then call evals_approve_case."
              : "Call evals_get_case to read a case, or evals_start_run to run the approved cases.",
        };
      },
    }),
    defineOperation({
      id: "evals_get_case",
      domain: "evals",
      title: "Read an eval case",
      description:
        "Use this tool to read one eval case. It returns the eval id, the input, the expected output and the state of the newest version. It also returns the version that counts in an eval run. The scorers are the eval's: evals_get returns them.",
      keywords: ["evals", "case detail", "expected output"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, caseId: caseIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const evalCase = await deps.getCase(ctx.projectId, params.caseId);
        if (!evalCase) throw notFound("eval case");
        const readable = await deps.mayReadContent(ctx);
        const [newest] = evalCase.versions;
        const draft = draftVersion(evalCase);
        return {
          data: {
            caseId: evalCase.id,
            evalId: evalCase.evalId,
            name: evalCase.name,
            labels: evalCase.labels,
            newest: newest ? versionView(newest, readable) : null,
            approvedVersion: approvedVersion(evalCase)?.number ?? null,
            ...(readable ? {} : { contentWithheld: true }),
          },
          hint: !readable
            ? CONTENT_WITHHELD_HINT
            : draft
              ? (approvalProblem(draft) ??
                `The newest version is a draft. Call evals_approve_case with caseId "${evalCase.id}" to make it count.`)
              : "The newest version is approved. It counts in the next eval run.",
        };
      },
    }),
    defineOperation({
      id: "evals_create_case",
      domain: "evals",
      title: "Create an eval case",
      description:
        "Use this tool to save a trace turn, a sandbox run or an input as a draft case of an eval. This tool changes data. With no eval, the case goes into the eval of the task of the turn. When the task has no eval, confirmNewEval true creates it with the default scorers of the task. It returns the case id, the eval id and the draft version number.",
      keywords: ["evals", "save as case", "new case", "trace to eval"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("A short name that says what the case tests. A turn gives one."),
        eval: evalParam
          .optional()
          .describe(
            "The eval whose dataset gets the case (its name or id). A name that no eval has makes a new eval with the scorers that you give. Omit it to use the eval of the task.",
          ),
        turnId: uuidParam()
          .optional()
          .describe("A trace turn to copy: its input and its tool fixtures."),
        sandboxRunId: uuidParam()
          .optional()
          .describe("A sandbox run to copy. Its input becomes the input of the case."),
        task: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The task id to use when the turn or the run has more than one task."),
        confirmNewEval: z
          .boolean()
          .default(false)
          .describe("True creates the eval of the task when it does not exist."),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        input: z
          .unknown()
          .optional()
          .describe("The input of the agent. Give this, a turnId or a sandboxRunId."),
        expectedOutput: z
          .string()
          .max(20_000)
          .optional()
          .describe("The answer that is correct, as text. A judge reads it."),
        scorers: z
          .array(scorerParam)
          .max(20)
          .optional()
          .describe(
            "The scorers of a new eval that you name. A trial passes when every gating scorer passes.",
          ),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const made = await caseSource(deps, ctx, params);
        const content = caseContentSchema.safeParse(storable(made.content));
        if (!content.success) throw contentRefusal(content.error);
        const target = params.eval
          ? await evalNamed(deps, ctx, params.eval, params.scorers ?? [])
          : await evalOfTask(deps, ctx, made.source, params.task ?? null, params.confirmNewEval);
        const created = await deps.createCase({
          projectId: ctx.projectId,
          evalId: target.id,
          name: params.name ?? made.name,
          labels: [...new Set(params.labels ?? [])],
          content: content.data,
          createdBy: requester(ctx.auth),
          ...(made.origin ? { source: made.origin } : {}),
        });
        if (created === "eval_not_found") throw notFound("eval");
        const draft = draftVersion(created);
        const problem = approvalProblem(content.data) ?? runProblem(currentVersion(target));
        return {
          data: {
            caseId: created.id,
            evalId: target.id,
            eval: target.name,
            name: created.name,
            draftVersion: draft?.number ?? null,
            state: "draft",
            ...(problem ? { approvalProblem: problem } : {}),
          },
          hint: problem
            ? `${problem} The case is saved as a draft.`
            : `Call evals_approve_case with caseId "${created.id}" to make the case count in an eval run.`,
        };
      },
    }),
    defineOperation({
      id: "evals_approve_case",
      domain: "evals",
      title: "Approve an eval case",
      description:
        "Use this tool to approve the draft of an eval case. This tool changes data: the draft becomes the version that counts in the next eval run. It returns the case id, the version number and the state. It refuses a draft with no input or no gating scorer.",
      keywords: ["evals", "approve case"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({ ...projectScoped, caseId: caseIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const evalCase = await deps.getCase(ctx.projectId, params.caseId);
        if (!evalCase) throw notFound("eval case");
        const draft = draftVersion(evalCase);
        if (!draft) {
          throw new McpOperationError(
            "conflict",
            "This case has no draft. Its newest version is approved.",
            {
              reason: "no_draft",
            },
          );
        }
        const problem = approvalProblem(draft);
        if (problem) {
          throw new McpOperationError("conflict", problem, { reason: "not_ready" });
        }
        const result = await deps.approveCase(
          ctx.projectId,
          evalCase.id,
          { versionId: draft.id, updatedAt: draft.updatedAt },
          { userId: requester(ctx.auth), now: deps.now() },
        );
        if (result === "not_found") throw notFound("eval case");
        if (result === "changed") {
          throw new McpOperationError(
            "conflict",
            "Another person changed this case. Read it again.",
            {
              reason: "changed",
            },
          );
        }
        return {
          data: { caseId: evalCase.id, version: draft.number, state: "approved" },
          hint: "The case counts in the next eval run. Call evals_start_run to run the approved cases.",
        };
      },
    }),
    defineOperation({
      id: "evals_start_run",
      domain: "evals",
      title: "Start an eval run",
      description:
        "Use this tool to run the suite, or chosen evals, on a sandbox version. The suite is each eval of the sandbox with an approved case and a gating scorer. This tool changes data: it starts VM runs. It returns the run id, the state, the eval names, and the numbers of cases and trials. Call evals_get_run until the state is completed.",
      keywords: ["evals", "start eval run"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        sandboxVersion: z
          .union([z.literal("latest"), uuidParam()])
          .default("latest")
          .describe("A sandbox version id, or latest for the newest ready version."),
        evals: z
          .array(evalParam)
          .min(1)
          .max(100)
          .optional()
          .describe("The evals to run (names or ids). Omit it to run the suite."),
        trials: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRIALS)
          .optional()
          .describe("The runs of each case. Omit it to use the trials of each eval."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .default({})
          .describe(
            "Values for the params of the sandbox version. They go over the defaults of each eval.",
          ),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const organizationId = ctx.organizationId ?? (await deps.organizationIdOf(ctx.projectId));
        if (!organizationId) throw notFound("project");
        const result = await deps.startExperiment(
          { projectId: ctx.projectId, organizationId },
          {
            sandboxVersion: params.sandboxVersion,
            ...(params.trials === undefined ? {} : { trialsPerCase: params.trials }),
            ...(params.evals ? { evals: params.evals } : {}),
            params: params.params,
            startedBy: requester(ctx.auth),
          },
        );
        if (!result.ok) throw startRefusal(result);
        const { experiment } = result;
        deps.advance(experiment);
        return {
          data: {
            runId: experiment.id,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            evals: experiment.evalVersions.map(({ name }) => name),
            cases: experiment.caseVersions.length,
            trials: experiment.caseVersions.reduce(
              (sum, frozen) => sum + trialsOfCase(experiment, frozen),
              0,
            ),
          },
          hint: `The eval run started. Call evals_get_run with runId "${experiment.id}". It waits up to ${RUN_WAIT_MS / 1000} seconds for the run to end. Call it again while the state is running.`,
        };
      },
    }),
    defineOperation({
      id: "evals_list_runs",
      domain: "evals",
      title: "List eval runs",
      description:
        "Use this tool to find the eval runs of the project, newest first. It returns each run with its state, sandbox version and raw counts. It also says which run is the pinned baseline.",
      keywords: ["evals", "eval runs"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const [experiments, baseline] = await Promise.all([
          deps.listExperiments(ctx.projectId, LIST_LIMIT),
          deps.getBaseline(ctx.projectId),
        ]);
        const runs = await Promise.all(
          experiments.map(async (experiment) => ({
            runId: experiment.id,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            sandboxName: experiment.sandboxName,
            counts: countTrials(await deps.trials(experiment.id)),
            baseline: baseline?.experimentId === experiment.id,
            createdAt: experiment.createdAt.toISOString(),
          })),
        );
        return {
          data: { runs, baselineRunId: baseline?.experimentId ?? null },
          hint: "Call evals_get_run with a runId for its cases and outputs, or evals_compare to compare it with the baseline.",
        };
      },
    }),
    defineOperation({
      id: "evals_get_run",
      domain: "evals",
      title: "Read an eval run",
      description:
        "Use this tool to read an eval run. It waits up to 20 seconds for a running run. It returns the state, the raw counts, the verdict, and each eval with its score, its scorer pass rates and its delta against the pinned baseline (or the reason for no delta). For each case, it returns the input and the output and result of each trial.",
      keywords: ["evals", "eval results", "raw counts"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, runId: runIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const experiment = await waitForEnd(
          deps,
          ctx.projectId,
          await deps.getExperiment(ctx.projectId, params.runId),
        );
        if (!experiment) throw notFound("eval run");
        const [trials, readable, baseline] = await Promise.all([
          deps.trials(experiment.id),
          deps.mayReadContent(ctx),
          deps.pinnedRun(ctx.projectId),
        ]);
        const view = await runView(deps, ctx.projectId, experiment, trials, readable);
        return {
          data: { ...view.data, ...suiteView(suiteTable({ experiment, trials }, baseline)) },
          ...(view.truncated ? { truncated: true } : {}),
          hint: [
            experiment.state === "running"
              ? `The eval run is still running after a wait of ${RUN_WAIT_MS / 1000} seconds. Call evals_get_run with runId "${experiment.id}" again.`
              : `The eval run is completed. Call evals_compare with runId "${experiment.id}" to compare it with the baseline, or evals_pin_baseline to make it the baseline.`,
            ...(readable ? [] : [CONTENT_WITHHELD_HINT]),
          ].join(" "),
        };
      },
    }),
    defineOperation({
      id: "evals_get_trial",
      domain: "evals",
      title: "Read an eval trial",
      description:
        "Use this tool to read one trial of an eval run in full. It returns the output, the tool calls, each scorer result with its reason, and the sandbox run id.",
      keywords: ["evals", "trial detail", "scorer reason"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({
        ...projectScoped,
        runId: runIdParam,
        trialId: uuidParam().describe("The id of a trial. evals_get_run gives the trial ids."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const experiment = await deps.getExperiment(ctx.projectId, params.runId);
        const trial =
          experiment && (await deps.trials(experiment.id)).find(({ id }) => id === params.trialId);
        if (!experiment || !trial) throw notFound("eval trial");
        const readable = await deps.mayReadContent(ctx);
        const evidence = readable ? await deps.trialEvidence(ctx.projectId, trial.id) : null;
        const frozen = experiment.caseVersions.find(
          ({ versionId }) => versionId === trial.caseVersionId,
        );
        return {
          data: {
            trialId: trial.id,
            runId: experiment.id,
            caseId: frozen?.caseId ?? null,
            caseName: frozen?.name ?? null,
            index: trial.index,
            state: trial.state,
            result: trial.result,
            reason: trial.reason,
            output: evidence?.output ?? null,
            toolCalls: evidence?.toolCalls ?? [],
            scorers: trial.scorers.map((scorer) => scorerView(scorer, readable)),
            durationMs: trial.durationMs,
            costUsd: trial.costUsd,
            sandboxRunId: trial.sandboxRunId,
            traceId: trial.traceId,
            ...(readable ? {} : { contentWithheld: true }),
          },
          ...(readable ? {} : { hint: CONTENT_WITHHELD_HINT }),
        };
      },
    }),
    defineOperation({
      id: "evals_compare",
      domain: "evals",
      title: "Compare two eval runs",
      description:
        "Use this tool to compare the cases of an eval run with the pinned baseline, or with baselineRunId. It returns the verdict, its rule, and the changed cases with the outputs of both runs. It leaves out the cases of an eval whose scorers differ, and says why. For the score and the delta of each eval, use evals_get_run.",
      keywords: ["evals", "regression", "verdict"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({
        ...projectScoped,
        runId: runIdParam,
        baselineRunId: uuidParam()
          .optional()
          .describe("The eval run to compare with. Omit it to use the pinned baseline."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const compared = params.baselineRunId
          ? await compareTwo(deps, ctx.projectId, params.runId, params.baselineRunId)
          : await pinnedComparison(deps, ctx.projectId, params.runId);
        const readable = await deps.mayReadContent(ctx);
        const data = await comparisonView(deps, ctx.projectId, compared, readable);
        return {
          data,
          hint: !readable
            ? CONTENT_WITHHELD_HINT
            : compared.comparison.verdict === "regressed"
              ? "A case went from pass to fail. Read the changed cases, then evals_get_trial for the full output."
              : "Call evals_pin_baseline with this runId to make it the new baseline.",
        };
      },
    }),
    defineOperation({
      id: "evals_pin_baseline",
      domain: "evals",
      title: "Pin the eval baseline",
      description:
        "Use this tool to make a completed eval run the baseline of the project. This tool changes data: it replaces the pinned baseline. It returns the baseline run id and the time of the pin. evals_compare uses this baseline when you give no baselineRunId.",
      keywords: ["evals", "pin baseline"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({ ...projectScoped, runId: runIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const result = await deps.pinBaseline(ctx.projectId, params.runId, requester(ctx.auth));
        if (!result.ok) {
          if (result.reason === "not_found") throw notFound("eval run");
          throw new McpOperationError("conflict", result.message, { reason: result.reason });
        }
        return {
          data: {
            baselineRunId: result.baseline.experimentId,
            pinnedAt: result.baseline.pinnedAt.toISOString(),
          },
          hint: "Call evals_compare with the runId of a later eval run to compare it with this baseline.",
        };
      },
    }),
  ];
}

/** Whether the eval tools are listed for a caller. A failed decision hides them. */
export async function evalsForCaller(auth: McpAuthContext): Promise<boolean> {
  try {
    if (auth.kind === "api-key") return await evalsEnabledForProject(auth.projectId);
    const organizations = auth.memberships.map(({ organizationId }) => ({ id: organizationId }));
    return (await evalsOrganizationIds(organizations)).length > 0;
  } catch {
    return false;
  }
}

// — Helpers ——————————————————————————————————————————————————————————————————

type Compared = {
  baselineRunId: string;
  candidateRunId: string;
  baselinePinned: boolean;
  comparison: Comparison;
  baselineTrials: Trial[];
  candidateTrials: Trial[];
};

async function requireEvals(deps: EvalsOperationDeps, projectId: string): Promise<void> {
  if (await deps.enabled(projectId)) return;
  throw new McpOperationError("forbidden", "Evals are not on for this project.", {
    reason: "evals_off",
  });
}

/** Waits a short time for a running eval run to end. A call is limited to 60 seconds. */
async function waitForEnd(
  deps: EvalsOperationDeps,
  projectId: string,
  experiment: Experiment | null,
): Promise<Experiment | null> {
  const deadline = deps.now().getTime() + RUN_WAIT_MS;
  let current = experiment;
  while (current?.state === "running" && deps.now().getTime() < deadline) {
    await deps.sleep(POLL_MS);
    current = (await deps.getExperiment(projectId, current.id)) ?? current;
  }
  return current;
}

/** Steps a new eval run until it closes. Each step is safe next to the sweep. */
async function drive(experiment: Experiment): Promise<void> {
  const deps = experimentDeps();
  const until = Date.now() + DRIVE_MS;
  while (Date.now() < until) {
    const step = await advance(experiment, deps, new Date(until));
    if (step.closed) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function requester(auth: McpAuthContext): string {
  return auth.kind === "api-key" ? `mcp:key:${auth.apiKeyId}` : `mcp:user:${auth.userId}`;
}

function versionView(version: CaseVersion, readable: boolean) {
  return {
    versionId: version.id,
    number: version.number,
    state: version.state,
    input: readable ? version.input : null,
    expectedOutput: readable ? version.expectedOutput : null,
    sourceOutput: readable ? version.sourceOutput : null,
    earlierTurns: readable ? version.earlierTurns.length : 0,
    toolFixtures: version.toolFixtures.length,
    approvedAt: version.approvedAt?.toISOString() ?? null,
    updatedAt: version.updatedAt.toISOString(),
  };
}

async function runSource(deps: EvalsOperationDeps, projectId: string, runId: string) {
  const run = await deps.getSandboxRun(projectId, runId);
  if (!run) throw notFound("sandbox run");
  if (run.status === "queued" || run.status === "running") {
    throw new McpOperationError(
      "conflict",
      `The sandbox run is ${run.status}. Call sandbox_get_run until it ends, then save it.`,
      { reason: "run_active" },
    );
  }
  const output = run.result?.output ?? run.response?.output ?? null;
  return {
    input: run.request.input,
    output: output === null ? null : typeof output === "string" ? output : JSON.stringify(output),
    traceId: run.traceId ?? null,
  };
}

type CaseSourceParams = {
  name?: string | undefined;
  turnId?: string | undefined;
  sandboxRunId?: string | undefined;
  input?: unknown;
  expectedOutput?: string | undefined;
};

/** What the case holds, where it comes from, and the turn or trace whose tasks choose its eval. */
async function caseSource(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  params: CaseSourceParams,
): Promise<{
  name: string;
  content: unknown;
  origin: { turnId: string | null; output: string | null } | null;
  source: SaveSource;
}> {
  const expectedOutput = params.expectedOutput ?? null;
  if (params.turnId) {
    if (!(await deps.mayReadContent(ctx))) {
      throw new McpOperationError(
        "forbidden",
        "A case from a turn copies captured text. This key or this project does not allow it.",
        { reason: "no_content_access" },
      );
    }
    const turn = await deps.turnCase(ctx.projectId, params.turnId);
    if (!turn) throw notFound("turn with an input");
    return {
      name: params.name ?? turn.name,
      content: { ...turn.content, expectedOutput: expectedOutput ?? turn.content.expectedOutput },
      origin: { turnId: params.turnId, output: turn.sourceOutput },
      source: { turnId: params.turnId },
    };
  }
  const run = params.sandboxRunId
    ? await runSource(deps, ctx.projectId, params.sandboxRunId)
    : null;
  const input = run ? run.input : params.input;
  if (input === undefined || input === null) {
    throw invalidParams("Give an input, a turnId or a sandboxRunId.", [
      { path: "input", message: "Give an input, a turnId or a sandboxRunId." },
    ]);
  }
  if (!params.name) {
    throw invalidParams("Give the case a name.", [{ path: "name", message: "Give a name." }]);
  }
  return {
    name: params.name,
    content: { input, expectedOutput },
    origin: run ? { turnId: null, output: run.output } : null,
    source: run?.traceId ? { traceId: run.traceId } : null,
  };
}

/**
 * The eval of the task of the turn or the run (decision `trace-to-eval`). A new eval of a task
 * needs `confirmNewEval`: the caller sees its name and its scorers first.
 */
async function evalOfTask(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  source: SaveSource,
  task: string | null,
  confirmed: boolean,
): Promise<EvalDefinition> {
  const options = await deps.saveOptions(ctx.projectId, source, task);
  const taskId = task ?? options.defaultTaskId;
  if (options.tasks.length === 0 || (task && !options.targets[task])) {
    throw invalidParams("No task matched this case. Give the name of its eval in eval.", [
      { path: "eval", message: "Give the eval of the case." },
    ]);
  }
  const target = taskId ? options.targets[taskId] : undefined;
  if (!target) {
    const tasks = options.tasks.map(({ id, name }) => `${id} (${name})`).join(", ");
    throw new McpOperationError(
      "conflict",
      `The case has more than one task: ${tasks}. Give one in task.`,
      {
        reason: "choose_task",
      },
    );
  }
  if (target.kind === "existing") {
    const found = await deps.getEval(ctx.projectId, target.evalId);
    if (!found) throw notFound("eval");
    return found;
  }
  if (target.kind !== "new") throw notFound("eval");
  if (!confirmed) {
    const scorers = target.content.scorers.map(({ name }) => `"${name}"`).join(", ") || "none";
    throw new McpOperationError(
      "conflict",
      `The task has no eval. Call again with confirmNewEval true to create the eval "${target.name}" with these scorers: ${scorers}.`,
      { reason: "confirm_new_eval" },
    );
  }
  const created = await deps.createEval({
    projectId: ctx.projectId,
    name: target.name,
    taskId: target.taskId,
    content: target.content,
    createdBy: requester(ctx.auth),
  });
  if (created !== "name_taken") return created;
  const made = await deps.getEvalByName(ctx.projectId, target.name);
  if (!made) throw notFound("eval");
  return made;
}

/** An eval by its name, else by its id. */
async function findEval(
  deps: EvalsOperationDeps,
  projectId: string,
  nameOrId: string,
): Promise<EvalDefinition | null> {
  const byName = await deps.getEvalByName(projectId, nameOrId);
  if (byName) return byName;
  return z.uuid().safeParse(nameOrId).success ? deps.getEval(projectId, nameOrId) : null;
}

function evalScorerView({ name, gating, definition }: EvalScorer, readable: boolean) {
  return {
    name,
    gating,
    kind: definition.kind,
    ...(definition.kind === "check"
      ? { check: definition.config }
      : { question: readable ? definition.config.prompt : null }),
  };
}

/** The eval with this name or id. When there is none, a new eval with this name and these scorers. */
async function evalNamed(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  name: string,
  scorers: readonly z.output<typeof scorerParam>[],
): Promise<EvalDefinition> {
  const found = await findEval(deps, ctx.projectId, name);
  if (found) return found;
  const content = evalContentSchema.safeParse({ scorers: scorers.map(evalScorer) });
  if (!content.success) throw contentRefusal(content.error);
  const created = await deps.createEval({
    projectId: ctx.projectId,
    name,
    taskId: null,
    content: content.data,
    createdBy: requester(ctx.auth),
  });
  if (created !== "name_taken") return created;
  // Another call made it at the same time.
  const made = await deps.getEvalByName(ctx.projectId, name);
  if (!made) throw notFound("eval");
  return made;
}

function evalScorer(scorer: z.output<typeof scorerParam>): EvalScorer {
  const base = { id: randomUUID(), name: scorer.name, gating: scorer.gating };
  if (scorer.kind === "judge") {
    return {
      ...base,
      definition: { kind: "judge", config: { prompt: scorer.question, output: "boolean" } },
    };
  }
  const { path, op, value } = scorer;
  return {
    ...base,
    definition: { kind: "check", config: { path, op, ...(value === undefined ? {} : { value }) } },
  };
}

function contentRefusal(error: z.ZodError): McpOperationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const [first] = issues;
  const message = first
    ? `The case is not valid: ${first.path ? `${first.path}: ` : ""}${first.message}.`
    : "The case is not valid.";
  return invalidParams(message, issues);
}

const START_REFUSAL = {
  sandboxes_off: "forbidden",
  not_found: "not_found",
  not_ready: "conflict",
  no_cases: "conflict",
  too_many_running: "quota_exceeded",
  too_many_trials: "invalid_params",
  invalid_params: "invalid_params",
  wrong_sandbox: "conflict",
} as const;

function startRefusal(result: Extract<StartExperimentResult, { ok: false }>): McpOperationError {
  return new McpOperationError(START_REFUSAL[result.reason], result.message, {
    reason: result.reason,
  });
}

async function runView(
  deps: EvalsOperationDeps,
  projectId: string,
  experiment: Experiment,
  trials: readonly Trial[],
  readable: boolean,
) {
  const byCase = trialsByCase(trials);
  let budget = readable ? OUTPUTS_SHOWN : 0;
  let truncated = false;
  const cases = await Promise.all(
    caseCounts(experiment, trials).map(async (frozen) => {
      const version = readable ? await deps.caseVersion(frozen.versionId) : null;
      const caseTrials = byCase.get(frozen.versionId) ?? [];
      const rows = await Promise.all(
        caseTrials.map(async (trial) => {
          const show = trial.state === "done" && budget > 0;
          if (show) budget -= 1;
          else if (readable && trial.state === "done") truncated = true;
          const evidence = show ? await deps.trialEvidence(projectId, trial.id) : null;
          const output = evidence ? preview(evidence.output, TEXT_CHARS) : null;
          if (output?.truncated) truncated = true;
          return {
            trialId: trial.id,
            index: trial.index,
            state: trial.state,
            result: trial.result,
            output: output?.value ?? null,
            ...(trial.result === "invalid" ? { reason: trial.reason } : {}),
            scorers: trial.scorers.map(({ name, gating, status }) => ({ name, gating, status })),
          };
        }),
      );
      const input = version ? preview(version.input, INPUT_CHARS) : null;
      if (input?.truncated) truncated = true;
      return {
        caseId: frozen.caseId,
        name: frozen.name,
        version: frozen.number,
        input: input?.value ?? null,
        counts: frozen.counts,
        trials: rows,
      };
    }),
  );
  return {
    data: {
      runId: experiment.id,
      state: experiment.state,
      counts: countTrials(trials),
      cases,
      sandboxVersionId: experiment.sandboxVersionId,
      sandboxName: experiment.sandboxName,
      params: experiment.params,
      trialsPerCase: experiment.trialsPerCase,
      createdAt: experiment.createdAt.toISOString(),
      finishedAt: experiment.finishedAt?.toISOString() ?? null,
      ...(readable ? {} : { contentWithheld: true }),
    },
    truncated,
  };
}

/** The suite table of a run: each eval with its score and its delta, and the verdict. */
function suiteView(table: ReturnType<typeof suiteTable>) {
  return {
    baselineRunId: table.baselineId,
    verdict: table.verdict,
    evals: table.rows.map((row) => ({
      evalId: row.evalId,
      key: deltaKey(row),
      name: row.name,
      version: row.number,
      cases: row.cases,
      counts: row.counts,
      score: row.score,
      scorers: row.scorers.map(({ hash: _, ...scorer }) => scorer),
      delta: row.delta?.ok ? { score: row.delta.score, scorers: row.delta.scorers } : null,
      deltaRefusal:
        row.delta && !row.delta.ok
          ? { reason: row.delta.reason, message: row.delta.message }
          : null,
    })),
  };
}

/** A JSON value as it is when it is small, else a text preview of it. */
function preview(value: unknown, max: number): { value: unknown; truncated: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return { value, truncated: false };
  return { value: truncateText(text, max).text, truncated: true };
}

function scorerView(scorer: Trial["scorers"][number], readable: boolean) {
  return {
    name: scorer.name,
    kind: scorer.kind,
    gating: scorer.gating,
    status: scorer.status,
    reason: readable ? scorer.reason : null,
    ...(scorer.model ? { model: scorer.model } : {}),
  };
}

async function pinnedComparison(
  deps: EvalsOperationDeps,
  projectId: string,
  runId: string,
): Promise<Compared> {
  const result = await deps.compareWithBaseline(projectId, runId);
  if (!result.ok) {
    if (result.refusal.reason === "not_found") throw notFound("eval run");
    throw compareRefusal(result.refusal);
  }
  return {
    baselineRunId: result.baseline.experiment.id,
    candidateRunId: result.candidate.experiment.id,
    baselinePinned: true,
    comparison: result.comparison,
    baselineTrials: result.baseline.trials,
    candidateTrials: result.candidate.trials,
  };
}

async function compareTwo(
  deps: EvalsOperationDeps,
  projectId: string,
  runId: string,
  baselineRunId: string,
): Promise<Compared> {
  const [candidate, baseline] = await Promise.all([
    deps.getExperiment(projectId, runId),
    deps.getExperiment(projectId, baselineRunId),
  ]);
  if (!candidate || !baseline) throw notFound("eval run");
  const [baselineTrials, candidateTrials] = await Promise.all([
    deps.trials(baseline.id),
    deps.trials(candidate.id),
  ]);
  const comparison = compare(
    { experiment: baseline, trials: baselineTrials },
    { experiment: candidate, trials: candidateTrials },
  );
  if (!comparison.ok) throw compareRefusal(comparison);
  const pin = await deps.getBaseline(projectId);
  return {
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    baselinePinned: pin?.experimentId === baseline.id,
    comparison,
    baselineTrials,
    candidateTrials,
  };
}

function compareRefusal(
  refusal: Pick<CompareRefusal, "message"> & { reason: string },
): McpOperationError {
  return new McpOperationError("conflict", refusal.message, { reason: refusal.reason });
}

async function comparisonView(
  deps: EvalsOperationDeps,
  projectId: string,
  compared: Compared,
  readable: boolean,
) {
  const { comparison } = compared;
  const firstOutput = async (trials: readonly Trial[], versionId: string | undefined) => {
    if (!readable || !versionId) return null;
    const trial = trials.find(
      (one) => one.caseVersionId === versionId && one.state === "done" && one.result !== "invalid",
    );
    const evidence = trial ? await deps.trialEvidence(projectId, trial.id) : null;
    return evidence ? preview(evidence.output, TEXT_CHARS).value : null;
  };
  const changed = await Promise.all(
    comparison.cases
      .filter(({ change }) => change !== "unchanged")
      .map(async (row) => ({
        caseId: row.caseId,
        name: row.name,
        change: row.change,
        baseline: row.baseline && {
          status: row.baseline.status,
          counts: row.baseline.counts,
          output: await firstOutput(compared.baselineTrials, row.baseline.versionId),
        },
        candidate: row.candidate && {
          status: row.candidate.status,
          counts: row.candidate.counts,
          output: await firstOutput(compared.candidateTrials, row.candidate.versionId),
        },
      })),
  );
  return {
    verdict: comparison.verdict,
    rule: comparison.rule,
    baselineRunId: compared.baselineRunId,
    baselinePinned: compared.baselinePinned,
    candidateRunId: compared.candidateRunId,
    changedCases: changed,
    excludedMessage: comparison.excludedMessage,
    unchangedCases: comparison.cases
      .filter(({ change }) => change === "unchanged")
      .map(({ caseId, name, candidate }) => ({ caseId, name, status: candidate?.status ?? null })),
    ...(readable ? {} : { contentWithheld: true }),
  };
}
