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
  type CaseVersion,
  caseContentSchema,
  currentVersion as currentRow,
  type EvalCase,
} from "@/lib/views/evals/domain/case";
import { type CompareRefusal, type Comparison, compare } from "@/lib/views/evals/domain/compare";
import {
  currentVersion,
  type EvalDefinition,
  type EvalScorer,
  type EvalScorerRef,
  evalContentSchema,
  MAX_EVAL_NAME_CHARS,
  refIdOf,
  runProblem,
} from "@/lib/views/evals/domain/eval";
import type { SaveTarget } from "@/lib/views/evals/domain/eval-target";
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
  type StartEachEval,
  type StartExperimentResult,
  startEachEval,
} from "@/lib/views/evals/experiments";
import { evalsEnabledForProject, evalsOrganizationIds } from "@/lib/views/evals/gate";
import type { Baseline } from "@/lib/views/evals/ports/baseline-store";
import type { CaseRefusal, NewCase } from "@/lib/views/evals/ports/case-store";
import type { NewEval } from "@/lib/views/evals/ports/eval-store";
import type { Dataset } from "@/lib/views/evals/domain/dataset";
import { datasetSettingsSchema, MAX_DATASET_NAME_CHARS, MAX_ROW_LIMIT } from "@/lib/views/evals/domain/dataset";
import { matrixInputSchema } from "@/lib/views/evals/domain/matrix";
import { PREDEFINED_KEYS, predefinedScorer } from "@/lib/views/evals/domain/predefined-scorers";
import type { LibraryScorer } from "@/lib/views/evals/domain/scorer-library";
import { runScore } from "@/lib/views/evals/domain/history";
import {
  addRows,
  createDataset,
  type DatasetRead,
  type EvalRead,
  type NewRow,
  loadDataset,
  loadDatasets,
  loadEval,
  loadLibrary,
  loadOverview,
} from "@/lib/views/evals/evals-service";
import type { DatasetListRow, EvalsOverview } from "@/lib/views/evals/history-view";
import { evalsServiceDeps } from "@/lib/views/evals/service-deps";
import { NO_CONTENT_MESSAGE } from "@/lib/views/evals/datasets";
import { type SaveOptions, type SaveSource, saveOptions } from "@/lib/views/evals/save-target";
import { suiteTable } from "@/lib/views/evals/suite-view";
import { loadTurnContent } from "@/lib/views/evals/turn-content";
import { getRun, type SandboxRun } from "@/lib/views/sandboxes";

/**
 * The eval tools (decision `mcp-surface`): save a turn or a sandbox run as a case (it counts at
 * once, decision `rows-count-at-once`), start an eval run (an experiment) against a sandbox
 * version, read it, and compare it with a baseline. Ids start
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
  /** The pinned baseline run with its trials: of an eval, or of the project. Null when none is pinned. */
  pinnedRun(projectId: string, evalId?: string | null): Promise<ComparedRun | null>;
  getCase(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** One case for each input, in one transaction. */
  createCases(inputs: readonly NewCase[]): Promise<EvalCase[] | CaseRefusal>;
  getEvalByName(projectId: string, name: string): Promise<EvalDefinition | null>;
  createEval(input: NewEval): Promise<EvalDefinition | "name_taken" | "dataset_not_found">;
  /** One run for each eval, or for each eval named (decision `runs-per-eval`). */
  startEachEval(
    subject: UsageSubject,
    start: StartEachEval,
  ): ReturnType<typeof startEachEval>;
  /** Each eval with its rows, scorers, baseline score, newest score and series. */
  overview(projectId: string): Promise<EvalsOverview>;
  /** One eval (id or name) with its dataset and its runs. */
  evalRuns(projectId: string, wanted: string): Promise<EvalRead | null>;
  listDatasets(projectId: string): Promise<DatasetListRow[]>;
  /** One dataset (id or name) with the rows of a fixed one. */
  getDataset(projectId: string, wanted: string): Promise<DatasetRead | null>;
  createDataset(
    projectId: string,
    input: { name: string; definition: z.output<typeof datasetSettingsSchema> },
    createdBy: string,
  ): Promise<Dataset | "name_taken">;
  addRows(
    projectId: string,
    datasetId: string,
    rows: readonly NewRow[],
    createdBy: string,
  ): Promise<EvalCase[] | CaseRefusal>;
  /** The scorer library: the project's scorers, the pre-defined set and the evals' own. */
  library(projectId: string): Promise<LibraryScorer[]>;
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
  getBaseline(projectId: string, evalId?: string | null): Promise<Baseline | null>;
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
/** The runs of one eval that `evals_get` returns, the newest first. */
const RUNS_SHOWN = 20;
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
  pinnedRun: (projectId, evalId) => pinnedRun(projectId, baselineDeps(), evalId ?? null),
  getCase: (projectId, caseId) => createDrizzleCaseStore(getDb()).get(projectId, caseId),
  createCases: (inputs) => createDrizzleCaseStore(getDb()).createAll(inputs),
  getEvalByName: (projectId, name) => createDrizzleEvalStore(getDb()).getByName(projectId, name),
  createEval: (input) => createDrizzleEvalStore(getDb()).create(input),
  startEachEval: (subject, start) => startEachEval(subject, start, experimentDeps()),
  overview: (projectId) => loadOverview(projectId, evalsServiceDeps()),
  evalRuns: (projectId, wanted) => loadEval(projectId, wanted, evalsServiceDeps()),
  listDatasets: (projectId) => loadDatasets(projectId, evalsServiceDeps()),
  getDataset: (projectId, wanted) => loadDataset(projectId, wanted, evalsServiceDeps()),
  createDataset: (projectId, input, by) => createDataset(projectId, input, by, evalsServiceDeps()),
  addRows: (projectId, datasetId, rows, by) =>
    addRows(projectId, datasetId, rows, by, evalsServiceDeps()),
  library: (projectId) => loadLibrary(projectId, evalsServiceDeps()),
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
  getBaseline: (projectId, evalId) => baselineDeps().baselines.get(projectId, evalId ?? null),
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
const datasetParam = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DATASET_NAME_CHARS)
  .describe("The name or the id of a dataset. evals_list_datasets gives them.");
const paramValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const matrixParam = matrixInputSchema
  .optional()
  .describe(
    "For some params, a list of values. A run has one variant for each combination, at most 12.",
  );
const taskIdParam = z.string().trim().min(1).max(200);
const evalParam = z
  .string()
  .trim()
  .min(1)
  .max(MAX_EVAL_NAME_CHARS)
  .describe("The name or the id of an eval. evals_list gives them.");

/** A scorer as an agent writes it: a scorer of the library, or a check or a judge of the eval. */
const scorerParam = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("library"),
    scorer: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "The id of a scorer of the library: project:<id> or predefined:<key>. evals_list_scorers gives them.",
      ),
    value: z
      .union([z.string().trim().min(1).max(500), z.number().min(0)])
      .optional()
      .describe("The setting of a pre-defined scorer that needs one: a text, a tool name or a limit."),
    gating: z.boolean().default(true),
  }),
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
        "Use this tool to see the evals of the project. An eval has one dataset, one runtime and scorers. It returns each eval with its id, name, dataset, number of cases (rows), number of scorers, baseline score, newest score, and a series of run time and score, oldest run first. A score is from 0 to 1.",
      keywords: ["evals", "eval definitions", "suite", "score history"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const [evals, overview] = await Promise.all([
          deps.listEvals(ctx.projectId),
          deps.overview(ctx.projectId),
        ]);
        const byId = new Map(evals.map((one) => [one.id, one]));
        return {
          data: {
            scoreRule: overview.scoreRule,
            evals: overview.evals.map((row) => {
              const definition = byId.get(row.evalId);
              const version = definition ? currentVersion(definition) : null;
              return {
                ...row,
                version: version?.number ?? null,
                trials: version?.trials ?? null,
                scorerNames: version ? version.scorers.map(refName) : [],
              };
            }),
          },
          hint:
            overview.evals.length === 0
              ? "No eval yet. Call evals_create, or evals_create_case with a turnId to save a trace turn into the eval of its task."
              : "Call evals_get with an eval name for its runs, or evals_start_run to start a run of each eval.",
        };
      },
    }),
    defineOperation({
      id: "evals_get",
      domain: "evals",
      title: "Read an eval",
      description:
        "Use this tool to read one eval by its name or id. It returns its newest version (dataset, runtime, params, matrix, trials, scorers), the rows of a fixed dataset, and its runs: for each run the dataset, runtime version, scorers, params, score, delta against the baseline, and variants. It also returns a series of pass rates for each scorer, oldest run first.",
      keywords: ["evals", "eval definition", "dataset", "scorers"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, eval: evalParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const definition = await findEval(deps, ctx.projectId, params.eval);
        if (!definition) throw notFound("eval");
        const [cases, readable, read] = await Promise.all([
          deps.listCases(ctx.projectId, definition.id),
          deps.mayReadContent(ctx),
          deps.evalRuns(ctx.projectId, definition.id),
        ]);
        const version = currentVersion(definition);
        const rows = capRows(cases, CASES_SHOWN);
        const problem = runProblem(version);
        return {
          data: {
            evalId: definition.id,
            name: definition.name,
            taskId: definition.taskId,
            version: version.number,
            dataset: read?.dataset
              ? {
                  datasetId: read.dataset.id,
                  name: read.dataset.name,
                  kind: read.dataset.definition.kind,
                }
              : null,
            sandboxName: version.sandboxName,
            sandboxVersionId: version.sandboxVersionId,
            params: version.params,
            matrix: version.matrix,
            trials: version.trials,
            scorers: version.scorers.map((scorer) => evalScorerView(scorer, readable)),
            scoreRule: read?.runs.scoreRule ?? null,
            baselineRunId: read?.runs.baselineRunId ?? null,
            runs: (read?.runs.runs ?? []).slice(0, RUNS_SHOWN),
            scorerSeries: read?.runs.scorerSeries ?? [],
            cases: rows.rows.map((evalCase) => ({
              caseId: evalCase.id,
              name: evalCase.name,
              labels: evalCase.labels,
              version: currentRow(evalCase)?.number ?? null,
            })),
            ...(problem ? { runProblem: problem } : {}),
            ...(readable ? {} : { contentWithheld: true }),
          },
          ...(rows.truncated ? { truncated: true } : {}),
          hint: problem
            ? `${problem} A run leaves this eval out until it has one.`
            : `Call evals_start_run with eval "${definition.name}" to start a run of this eval.`,
        };
      },
    }),
    defineOperation({
      id: "evals_create",
      domain: "evals",
      title: "Create an eval",
      description:
        "Use this tool to create an eval: a name, an optional task id, a dataset, a runtime (a sandbox and a pinned version, or its newest ready version), default params, a matrix, trials and scorers of the library. This tool changes data. With no dataset, it adds a fixed dataset with the name of the eval. It returns the eval id, the version number and the dataset id.",
      keywords: ["evals", "new eval", "eval runtime"],
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
        sandboxVersionId: uuidParam()
          .optional()
          .describe("A version of the sandbox to pin. Omit it to use its newest ready version."),
        dataset: datasetParam
          .optional()
          .describe("The dataset of the eval. Omit it to add a fixed dataset with the eval name."),
        params: paramValues
          .optional()
          .describe("The default params of a run. The params of a run go over them."),
        matrix: matrixParam,
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
        const dataset = params.dataset ? await deps.getDataset(ctx.projectId, params.dataset) : null;
        if (params.dataset && !dataset) throw notFound("dataset");
        const content = evalContentSchema.safeParse(
          storable({
            datasetId: dataset?.dataset.id ?? null,
            sandboxName: params.sandboxName ?? null,
            sandboxVersionId: params.sandboxVersionId ?? null,
            matrix: params.matrix ?? {},
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
        if (created === "dataset_not_found") throw notFound("dataset");
        const problem = runProblem(currentVersion(created));
        return {
          data: {
            evalId: created.id,
            name: created.name,
            version: 1,
            datasetId: currentVersion(created).datasetId,
          },
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
        "Use this tool to see the cases of the datasets of the project, or of one eval. It returns each case with its id, name, eval id, labels and the number of the version that counts. Each case counts in an eval run: the newest version of each.",
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
          version: currentRow(evalCase)?.number ?? null,
          createdAt: evalCase.createdAt.toISOString(),
        }));
        return {
          data: { cases },
          ...(read.truncated ? { truncated: true } : {}),
          hint:
            cases.length === 0
              ? "No case yet. Create one with evals_create_case."
              : "Call evals_get_case to read a case, or evals_start_run to run the cases.",
        };
      },
    }),
    defineOperation({
      id: "evals_get_case",
      domain: "evals",
      title: "Read an eval case",
      description:
        "Use this tool to read one eval case. It returns the eval id and the version that counts in an eval run (the newest): its number, input and expected output. The scorers are the eval's: evals_get returns them.",
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
        const current = currentRow(evalCase);
        return {
          data: {
            caseId: evalCase.id,
            evalId: evalCase.evalId,
            name: evalCase.name,
            labels: evalCase.labels,
            version: current ? versionView(current, readable) : null,
            ...(readable ? {} : { contentWithheld: true }),
          },
          hint: readable ? "This version counts in the next eval run." : CONTENT_WITHHELD_HINT,
        };
      },
    }),
    defineOperation({
      id: "evals_create_case",
      domain: "evals",
      title: "Create an eval case",
      description:
        "Use this tool to save a trace turn, a sandbox run or an input as a case of an eval. This tool changes data. The case counts at once. With no eval, it goes into the eval of each task in task, or of the one task. A task with more evals needs eval. confirmNewEval true creates a missing task eval. It returns each case with its id, eval and version number.",
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
          .union([taskIdParam, z.array(taskIdParam).min(1).max(20)])
          .optional()
          .describe(
            "The task id, or more task ids, when the turn or the run has more tasks. Each task gets one case.",
          ),
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
        const tasks = params.task === undefined ? [] : [params.task].flat();
        const targets = params.eval
          ? [await evalNamed(deps, ctx, params.eval, params.scorers ?? [])]
          : await evalsOfTasks(deps, ctx, made.source, tasks, params.confirmNewEval);
        const created = await deps.createCases(
          targets.map((target) => ({
            projectId: ctx.projectId,
            evalId: target.id,
            name: params.name ?? made.name,
            labels: [...new Set(params.labels ?? [])],
            content: content.data,
            createdBy: requester(ctx.auth),
            ...(made.origin ? { source: made.origin } : {}),
          })),
        );
        if (created === "eval_not_found") throw notFound("eval");
        if (created === "not_fixed") {
          throw new McpOperationError(
            "conflict",
            "The dataset of the eval is a query. A query dataset has no rows of its own: give the eval a fixed dataset first.",
            { reason: "not_fixed" },
          );
        }
        const cases = created.map((evalCase, n) => {
          const target = targets[n];
          const problem = target ? runProblem(currentVersion(target)) : null;
          return {
            caseId: evalCase.id,
            evalId: evalCase.evalId,
            eval: target?.name ?? null,
            name: evalCase.name,
            version: currentRow(evalCase)?.number ?? null,
            ...(problem ? { runProblem: problem } : {}),
          };
        });
        const problems = cases.flatMap(({ runProblem: problem }) => (problem ? [problem] : []));
        return {
          data: { cases },
          hint:
            problems.length > 0
              ? `${problems.join(" ")} A run leaves such an eval out until it has one.`
              : "The case counts in the next eval run. Call evals_start_run to run it.",
        };
      },
    }),
    defineOperation({
      id: "evals_start_run",
      domain: "evals",
      title: "Start eval runs",
      description:
        "Use this tool to start a run of one eval, or a run of each eval. A run can change, for itself only, the dataset, added rows, scorers, runtime version, params and matrix. A version applies only to the evals of its sandbox. This tool changes data: it starts VM runs. It returns each run (id, eval, state, variants), each refused eval with the reason, and the evals it left out.",
      keywords: ["evals", "start eval run", "matrix"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        eval: evalParam.optional().describe("The eval to run. Omit it to start a run of each eval."),
        evals: z
          .array(evalParam)
          .min(1)
          .max(100)
          .optional()
          .describe("Some evals to run, one run each (names or ids)."),
        sandboxVersion: z
          .union([z.literal("latest"), uuidParam()])
          .optional()
          .describe(
            "A sandbox version id, or latest. Omit it to use the runtime of each eval: its pinned version, else its newest ready version.",
          ),
        dataset: datasetParam.optional().describe("Another dataset for this run only."),
        rows: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200).optional(),
              input: z.unknown(),
              expectedOutput: z.string().max(20_000).optional(),
            }),
          )
          .max(MAX_ROW_LIMIT)
          .optional()
          .describe("Rows to add to the rows of the dataset, for this run only."),
        scorers: z
          .array(scorerParam)
          .max(20)
          .optional()
          .describe("Other scorers for this run only."),
        trials: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRIALS)
          .optional()
          .describe("The runs of each row. Omit it to use the trials of each eval."),
        params: paramValues
          .default({})
          .describe("Values for the params. They go over the defaults of each eval."),
        matrix: matrixParam,
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const organizationId = ctx.organizationId ?? (await deps.organizationIdOf(ctx.projectId));
        if (!organizationId) throw notFound("project");
        const names = params.eval ? [params.eval] : params.evals;
        const result = await deps.startEachEval(
          { projectId: ctx.projectId, organizationId },
          {
            ...(names ? { evals: names } : {}),
            startedBy: requester(ctx.auth),
            changes: {
              ...(params.sandboxVersion ? { sandboxVersion: params.sandboxVersion } : {}),
              ...(params.dataset ? { dataset: params.dataset } : {}),
              ...(params.rows ? { rows: params.rows } : {}),
              ...(params.scorers ? { scorers: params.scorers.map(evalScorer) } : {}),
              ...(Object.keys(params.params).length > 0 ? { params: params.params } : {}),
              ...(params.matrix ? { matrix: params.matrix } : {}),
              ...(params.trials === undefined ? {} : { trials: params.trials }),
            },
          },
        );
        if (!result.ok) throw startRefusal(result);
        const runs = [];
        const refused = [];
        for (const { evalId, name, result: one, note } of result.runs) {
          if (!one.ok) {
            refused.push({ evalId, eval: name, reason: one.reason, message: one.message });
            continue;
          }
          deps.advance(one.experiment);
          const { experiment } = one;
          runs.push({
            runId: experiment.id,
            evalId,
            eval: name,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            dataset: experiment.dataset?.name ?? null,
            cases: experiment.caseVersions.length,
            variants: Math.max(1, experiment.variants.length),
            trials: experiment.caseVersions.reduce(
              (sum, frozen) =>
                sum + trialsOfCase(experiment, frozen) * Math.max(1, experiment.variants.length),
              0,
            ),
            ...(note ? { note } : {}),
          });
        }
        if (runs.length === 0) {
          const [first] = refused;
          throw new McpOperationError(
            START_REFUSAL[first?.reason ?? "no_cases"],
            first?.message ?? "No eval could run.",
            { reason: first?.reason ?? "no_cases" },
          );
        }
        return {
          data: {
            runs,
            refused,
            leftOut: result.skipped.map(({ evalId, name, result: one }) => ({
              evalId,
              eval: name,
              reason: one.ok ? null : one.message,
            })),
          },
          hint: `The runs started. Call evals_get_run with each runId. It waits up to ${RUN_WAIT_MS / 1000} seconds for a run to end. Call it again while the state is running.`,
        };
      },
    }),
    defineOperation({
      id: "evals_list_runs",
      domain: "evals",
      title: "List eval runs",
      description:
        "Use this tool to find the eval runs of the project, newest first. It returns each run with its eval, its state, sandbox version and raw counts. It also says which run is the pinned baseline of its eval.",
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
        const pins = new Map(
          await Promise.all(
            [...new Set(experiments.flatMap(({ evalId }) => (evalId ? [evalId] : [])))].map(
              async (evalId) =>
                [evalId, (await deps.getBaseline(ctx.projectId, evalId))?.experimentId] as const,
            ),
          ),
        );
        const runs = await Promise.all(
          experiments.map(async (experiment) => ({
            runId: experiment.id,
            evalId: experiment.evalId,
            eval: experiment.evalVersions.length === 1 ? (experiment.evalVersions[0]?.name ?? null) : null,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            sandboxName: experiment.sandboxName,
            counts: countTrials(await deps.trials(experiment.id)),
            baseline: experiment.evalId
              ? pins.get(experiment.evalId) === experiment.id
              : baseline?.experimentId === experiment.id,
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
        "Use this tool to read an eval run. It waits up to 20 seconds for a running run. It returns the state, raw counts, verdict, dataset, changes, score (the mean of its variants), each variant with its score and delta, scorer pass rates, and the delta against the baseline of the eval or the reason for none. For each case, it returns the input, and the output and result of each trial.",
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
          deps.pinnedRun(ctx.projectId, experiment.evalId),
        ]);
        const view = await runView(deps, ctx.projectId, experiment, trials, readable);
        const own = experiment.evalId
          ? runScore({ experiment, trials }, experiment.evalId, baseline)
          : null;
        return {
          data: {
            ...view.data,
            ...suiteView(suiteTable({ experiment, trials }, baseline)),
            evalId: experiment.evalId,
            dataset: experiment.dataset,
            changes: experiment.changes,
            ...(own
              ? {
                  score: own.score,
                  delta: own.delta,
                  variants: own.variants.map(({ scorers, ...variant }) => ({
                    ...variant,
                    scorers: scorers.map(({ hash: _, ...scorer }) => scorer),
                  })),
                }
              : {}),
          },
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
        "Use this tool to make a completed eval run the baseline of its eval (a suite run from before: of the project). This tool changes data: it replaces the pinned baseline. It returns the baseline run id, its eval and the time of the pin. evals_compare and the deltas use this baseline.",
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
    defineOperation({
      id: "evals_list_datasets",
      domain: "evals",
      title: "List eval datasets",
      description:
        "Use this tool to see the datasets of the project. A dataset is a set of rows that evals use. It is fixed (rows of trace turns or typed values), or a query: the newest traces, the traces of a task, an RQL query, or a choice of Ratel. It returns each dataset with its id, name, kind, number of rows (fixed) or query text, update time, and the evals that use it.",
      keywords: ["evals", "datasets", "eval dataset"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const datasets = await deps.listDatasets(ctx.projectId);
        return {
          data: { datasets },
          hint:
            datasets.length === 0
              ? "No dataset yet. Call evals_create_dataset."
              : "Call evals_get_dataset with a name for its rows, or evals_add_to_dataset to add a row.",
        };
      },
    }),
    defineOperation({
      id: "evals_get_dataset",
      domain: "evals",
      title: "Read an eval dataset",
      description:
        "Use this tool to read one dataset by its name or id. It returns its kind and its settings, the evals that use it, and the rows of a fixed dataset: for each row its id, name, labels, source turn and the input of its newest version. A query dataset has no rows of its own: a run gets them when it starts.",
      keywords: ["evals", "dataset rows"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped, dataset: datasetParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const [found, readable] = await Promise.all([
          deps.getDataset(ctx.projectId, params.dataset),
          deps.mayReadContent(ctx),
        ]);
        if (!found) throw notFound("dataset");
        const rows = capRows(found.rows, CASES_SHOWN);
        return {
          data: {
            datasetId: found.dataset.id,
            name: found.dataset.name,
            definition: found.dataset.definition,
            evals: found.evals,
            rows: rows.rows.map((row) => {
              const version = currentRow(row);
              return {
                caseId: row.id,
                name: row.name,
                labels: row.labels,
                sourceTurnId: version?.sourceTurnId ?? null,
                version: version ? versionView(version, readable) : null,
              };
            }),
            ...(readable ? {} : { contentWithheld: true }),
          },
          ...(rows.truncated ? { truncated: true } : {}),
          ...(readable ? {} : { hint: CONTENT_WITHHELD_HINT }),
        };
      },
    }),
    defineOperation({
      id: "evals_create_dataset",
      domain: "evals",
      title: "Create an eval dataset",
      description:
        "Use this tool to create a dataset. The kind is fixed, last_traces (limit), task_traces (taskId, limit), rql (text with a trace_id column, days, limit) or choose (taskId or none, limit). A limit is from 1 to 500, 50 when you omit it. This tool changes data. It returns the dataset id, its name and its settings.",
      keywords: ["evals", "new dataset", "rql dataset"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        name: z.string().trim().min(1).max(MAX_DATASET_NAME_CHARS).describe("The name of the dataset."),
        definition: datasetSettingsSchema
          .default({ kind: "fixed" })
          .describe("The kind and its settings. Omit it for a fixed dataset."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const made = await deps.createDataset(
          ctx.projectId,
          { name: params.name, definition: params.definition },
          requester(ctx.auth),
        );
        if (made === "name_taken") {
          throw new McpOperationError("conflict", "Another dataset of the project has this name.", {
            reason: "name_taken",
          });
        }
        return {
          data: { datasetId: made.id, name: made.name, definition: made.definition },
          hint:
            made.definition.kind === "fixed"
              ? "Call evals_add_to_dataset to add rows, or evals_create with this dataset."
              : "A run gets the rows of this query when it starts. Call evals_create with this dataset.",
        };
      },
    }),
    defineOperation({
      id: "evals_add_to_dataset",
      domain: "evals",
      title: "Add a row to an eval dataset",
      description:
        "Use this tool to add a row to a fixed dataset: a copy of a trace turn (turnId), of a Playground run (sandboxRunId), or typed values (input). This tool changes data. The row counts at once. It returns the row id, its name and its version number.",
      keywords: ["evals", "trace to eval", "add dataset row", "playground to eval"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        dataset: datasetParam,
        name: z.string().trim().min(1).max(200).optional().describe("The name of the row."),
        turnId: uuidParam().optional().describe("A trace turn to copy: its input and its tool fixtures."),
        sandboxRunId: uuidParam()
          .optional()
          .describe("A Playground (sandbox) run to copy. Its input becomes the input of the row."),
        input: z.unknown().optional().describe("Typed values: the input of the agent."),
        expectedOutput: z.string().max(20_000).optional().describe("The answer that is correct."),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const found = await deps.getDataset(ctx.projectId, params.dataset);
        if (!found) throw notFound("dataset");
        if (found.dataset.definition.kind !== "fixed") {
          throw new McpOperationError(
            "conflict",
            "A query dataset has no rows of its own. Add the row to a fixed dataset.",
            { reason: "not_fixed" },
          );
        }
        if (params.turnId && !(await deps.mayReadContent(ctx))) {
          throw new McpOperationError("forbidden", NO_CONTENT_MESSAGE, {
            reason: "no_content_access",
          });
        }
        const made = await caseSource(deps, ctx, params);
        const content = caseContentSchema.safeParse(storable(made.content));
        if (!content.success) throw contentRefusal(content.error);
        const added = await deps.addRows(
          ctx.projectId,
          found.dataset.id,
          [
            {
              name: params.name ?? made.name,
              labels: params.labels ?? [],
              content: content.data,
              ...(made.origin ? { source: made.origin } : {}),
            },
          ],
          requester(ctx.auth),
        );
        if (added === "eval_not_found") throw notFound("dataset");
        if (added === "not_fixed") {
          throw new McpOperationError("conflict", "The dataset is a query.", { reason: "not_fixed" });
        }
        return {
          data: {
            rows: added.map((row) => ({
              caseId: row.id,
              datasetId: row.datasetId,
              name: row.name,
              version: currentRow(row)?.number ?? null,
            })),
          },
          hint: "The row counts in the next run of each eval that uses this dataset.",
        };
      },
    }),
    defineOperation({
      id: "evals_list_scorers",
      domain: "evals",
      title: "List the scorer library",
      description:
        "Use this tool to see the scorers that an eval can use: the scorers of the project, the pre-defined scorers, and the own scorers of each eval. It returns each scorer with its id for evals_create, its name, its kind, the setting that it needs, and whether an eval trial can run it, with the reason when it cannot.",
      keywords: ["evals", "scorer library", "pre-defined scorers"],
      scope: "project",
      mutates: false,
      apiKeyScope: "evals:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const scorers = await deps.library(ctx.projectId);
        return {
          data: { scorers },
          hint: 'Give a scorer to evals_create as { kind: "library", scorer: <refId> }, with value when it needs a setting.',
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
    input: readable ? version.input : null,
    expectedOutput: readable ? version.expectedOutput : null,
    sourceOutput: readable ? version.sourceOutput : null,
    earlierTurns: readable ? version.earlierTurns.length : 0,
    toolFixtures: version.toolFixtures.length,
    createdAt: version.updatedAt.toISOString(),
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
 * The evals of the tasks of the turn or the run (decision `trace-to-eval`): one row goes into each.
 * The tasks are the ones in `task`, else the one task, else the task of the page. A task with more
 * evals needs `eval`. A new eval of a task needs `confirmNewEval`: the caller sees its name and its
 * scorers first.
 */
async function evalsOfTasks(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  source: SaveSource,
  tasks: readonly string[],
  confirmed: boolean,
): Promise<EvalDefinition[]> {
  const options = await deps.saveOptions(ctx.projectId, source, tasks[0] ?? null);
  if (options.tasks.length === 0 || tasks.some((task) => !options.targets[task])) {
    throw invalidParams("No task matched this case. Give the name of its eval in eval.", [
      { path: "eval", message: "Give the eval of the case." },
    ]);
  }
  const chosen = tasks.length > 0 ? [...new Set(tasks)] : [options.defaultTaskId ?? ""];
  const targets = chosen.flatMap((taskId) => {
    const target = options.targets[taskId];
    return target ? [target] : [];
  });
  if (targets.length === 0) {
    const names = options.tasks.map(({ id, name }) => `${id} (${name})`).join(", ");
    throw new McpOperationError(
      "conflict",
      `The case has more than one task: ${names}. Give one or more in task.`,
      { reason: "choose_task" },
    );
  }
  const choose = targets.find((target) => target.kind === "choose");
  if (choose) {
    const names = choose.evals.map(({ name }) => `"${name}"`).join(", ");
    throw new McpOperationError(
      "conflict",
      `The task ${choose.taskId} has more evals: ${names}. Give one in eval.`,
      { reason: "choose_eval" },
    );
  }
  const fresh = targets.flatMap((target) => (target.kind === "new" ? [target] : []));
  if (fresh.length > 0 && !confirmed) {
    const words = fresh.map(({ name, content }) => {
      const scorers = content.scorers.map((scorer) => `"${refName(scorer)}"`).join(", ") || "none";
      return `"${name}" with these scorers: ${scorers}`;
    });
    throw new McpOperationError(
      "conflict",
      `The task has no eval. Call again with confirmNewEval true to create the eval ${words.join("; ")}.`,
      { reason: "confirm_new_eval" },
    );
  }
  const evals: EvalDefinition[] = [];
  for (const target of targets) {
    if (target.kind === "existing") {
      const found = await deps.getEval(ctx.projectId, target.evalId);
      if (!found) throw notFound("eval");
      evals.push(found);
    } else if (target.kind === "new") {
      evals.push(await createTaskEval(deps, ctx, target));
    }
  }
  return evals;
}

/** The new eval of a task. A name that another call took at the same time is that eval. */
async function createTaskEval(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  target: Extract<SaveTarget, { kind: "new" }>,
): Promise<EvalDefinition> {
  const created = await deps.createEval({
    projectId: ctx.projectId,
    name: target.name,
    taskId: target.taskId,
    content: target.content,
    createdBy: requester(ctx.auth),
  });
  if (created === "dataset_not_found") throw notFound("dataset");
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

function evalScorerView(ref: EvalScorerRef, readable: boolean) {
  if (ref.source === "project" || ref.source === "predefined") {
    return {
      name: refName(ref),
      gating: ref.gating,
      kind: "library" as const,
      scorer: refIdOf(ref),
      ...(ref.source === "predefined" && ref.value !== undefined ? { value: ref.value } : {}),
    };
  }
  const { name, gating, definition } = ref;
  return {
    name,
    gating,
    kind: definition.kind,
    ...(definition.kind === "check"
      ? { check: definition.config }
      : { question: readable ? definition.config.prompt : null }),
  };
}

/** The name of a scorer reference: the name of a pre-defined or own scorer, else its id. */
function refName(ref: EvalScorerRef): string {
  if (ref.source === "project") return refIdOf(ref);
  if (ref.source === "predefined") {
    const name = predefinedScorer(ref.key)?.name ?? ref.key;
    return ref.value === undefined ? name : `${name}: ${ref.value}`;
  }
  return ref.name;
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
  if (created === "dataset_not_found") throw notFound("dataset");
  if (created !== "name_taken") return created;
  // Another call made it at the same time.
  const made = await deps.getEvalByName(ctx.projectId, name);
  if (!made) throw notFound("eval");
  return made;
}

function evalScorer(scorer: z.output<typeof scorerParam>): EvalScorerRef {
  if (scorer.kind === "library") {
    const [source, ...rest] = scorer.scorer.split(":");
    const id = rest.join(":");
    if (source === "project" && z.uuid().safeParse(id).success) {
      return { source: "project", scorerId: id, gating: scorer.gating };
    }
    const key = PREDEFINED_KEYS.find((one) => one === id);
    if (source === "predefined" && key) {
      return {
        source: "predefined",
        key,
        gating: scorer.gating,
        ...(scorer.value === undefined ? {} : { value: scorer.value }),
      };
    }
    throw invalidParams(`There is no scorer ${scorer.scorer} in the library.`, [
      { path: "scorers", message: "Give an id that evals_list_scorers gives." },
    ]);
  }
  return ownScorer(scorer);
}

function ownScorer(scorer: Exclude<z.output<typeof scorerParam>, { kind: "library" }>): EvalScorer {
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
  invalid_matrix: "invalid_params",
  invalid_scorers: "conflict",
  invalid_rows: "invalid_params",
  no_content_access: "forbidden",
  too_many_rows: "invalid_params",
  invalid_query: "invalid_params",
} as const satisfies Record<StartExperimentResult extends infer R ? R extends { ok: false; reason: infer K } ? K & string : never : never, string>;

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
  const pin = await deps.getBaseline(projectId, candidate.evalId);
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
