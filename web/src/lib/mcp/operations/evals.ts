import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CHECK_OPERATORS } from "@/lib/contracts/check";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  CONTENT_WITHHELD_HINT,
  credentialMayReadContent,
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
import {
  type ActionDeps,
  type Actor,
  datasetFor,
  runChanges,
  withDefinitions,
} from "@/lib/views/evals/actions";
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
import { datasetQuerySchema } from "@/lib/views/evals/domain/dataset";
import {
  currentVersion,
  datasetOf,
  type EvalDefinition,
  type EvalScorer,
  evalContentSchema,
  MAX_EVAL_NAME_CHARS,
  matrixSchema,
  runProblem,
  scorerRefSchema,
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
import {
  type EachRunPart,
  type EvalRunChanges,
  startEachEvalRun,
  startEvalRun,
} from "@/lib/views/evals/eval-runs";
import { advance, consoleApiDeps, experimentDeps } from "@/lib/views/evals/experiment-deps";
import { caseCounts, runFields, trialsByCase } from "@/lib/views/evals/experiment-view";
import type { StartExperimentResult } from "@/lib/views/evals/experiments";
import { evalsEnabledForProject, evalsOrganizationIds } from "@/lib/views/evals/gate";
import type { Baseline } from "@/lib/views/evals/ports/baseline-store";
import type { CaseStore, NewCase } from "@/lib/views/evals/ports/case-store";
import type { EvalStore, NewEval } from "@/lib/views/evals/ports/eval-store";
import { rowOfSandboxRun } from "@/lib/views/evals/sandbox-rows";
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
  /** The pinned baseline run of an eval (of the suite runs: null) with its trials. Null: no pin. */
  pinnedRun(projectId: string, evalId: string | null): Promise<ComparedRun | null>;
  getCase(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** One case for each input, in one transaction. */
  createCases(inputs: readonly NewCase[]): ReturnType<CaseStore["createAll"]>;
  getEvalByName(projectId: string, name: string): Promise<EvalDefinition | null>;
  createEval(input: NewEval): ReturnType<EvalStore["create"]>;
  /** A run of one eval, or one run for each eval (or for the evals named). */
  startRuns(
    subject: UsageSubject,
    start: {
      eval?: string;
      evals?: string[];
      startedBy: string;
      /** May the caller copy captured text into the run? A query dataset needs it. */
      mayCopyContent: boolean;
      changes: EvalRunChanges;
    },
  ): Promise<{ ok: true; runs: EachRunPart[] } | Extract<StartExperimentResult, { ok: false }>>;
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
  /** The pin of an eval. With no eval: the pin of the suite runs. */
  getBaseline(projectId: string, evalId?: string | null): Promise<Baseline | null>;
  pinBaseline(projectId: string, experimentId: string, pinnedBy: string): Promise<PinResult>;
  /** Removes the pin of that run. False when it was not pinned. */
  unpinBaseline(projectId: string, experimentId: string): Promise<boolean>;
  /** The actions of the Datasets and Evals pages (`views/evals/actions.ts`). */
  actions(): ActionDeps;
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
  pinnedRun: (projectId, evalId) => pinnedRun(projectId, baselineDeps(), evalId),
  getCase: (projectId, caseId) => createDrizzleCaseStore(getDb()).get(projectId, caseId),
  createCases: (inputs) => createDrizzleCaseStore(getDb()).createAll(inputs),
  getEvalByName: (projectId, name) => createDrizzleEvalStore(getDb()).getByName(projectId, name),
  createEval: (input) => createDrizzleEvalStore(getDb()).create(input),
  startRuns: async (subject, { eval: one, evals, startedBy, mayCopyContent, changes }) => {
    if (one === undefined) {
      return startEachEvalRun(
        subject,
        { ...(evals ? { evals } : {}), startedBy, mayCopyContent, changes },
        experimentDeps(),
      );
    }
    const result = await startEvalRun(
      subject,
      { eval: one, startedBy, mayCopyContent, changes },
      experimentDeps(),
    );
    if (!result.ok) return result;
    const { experiment } = result;
    const name = experiment.evalVersions[0]?.name ?? one;
    return {
      ok: true,
      runs: [{ eval: name, evalId: experiment.evalId ?? "", ok: true, experiment, note: null }],
    };
  },
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
  unpinBaseline: (projectId, id) => baselineDeps().baselines.unpin(projectId, id),
  actions: () => consoleApiDeps.actions(),
  compareWithBaseline: (projectId, id) => compareWithBaseline(projectId, id, baselineDeps()),
  getSandboxRun: getRun,
  mayReadContent: (ctx) => mayReadContent(ctx, defaultContentAccessDeps),
  organizationIdOf: async (projectId) => (await getProjectById(projectId))?.organizationId ?? null,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const caseIdParam = uuidParam().describe("The id of a case. evals_list_cases gives the case ids.");
const runIdParam = uuidParam().describe("The id of an eval run. evals_start_run gives it.");
const taskIdParam = z.string().trim().min(1).max(200);
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

/** A scorer of the library: evals_list_scorers gives the references. */
const refScorerParam = z.object({
  name: z.string().trim().min(1).max(100),
  gating: z.boolean().default(true),
  ref: scorerRefSchema.describe(
    'A library reference: {"source":"project","scorerId":...} or {"source":"predefined","key":...,"settings":{...}}.',
  ),
});
const anyScorerParam = z.union([refScorerParam, scorerParam]);
const datasetQueryParam = z
  .object({
    kind: z.enum(["last_traces", "task_traces", "rql", "auto"]),
    limit: z.number().int().min(1).max(500).optional(),
    taskId: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().min(1).max(20_000).optional(),
  })
  .describe("A new query dataset for the eval, named after it. Or give dataset.");
const datasetNameParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("A dataset of the project (name or id). evals_list_datasets gives them.");
const matrixParam = z
  .record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])).min(1))
  .describe(
    "For each param, the values to try. A run has one variant for each combination, at most 12.",
  );

export function evalsOperations(deps: EvalsOperationDeps = defaultDeps): McpOperation[] {
  return [
    defineOperation({
      id: "evals_list",
      domain: "evals",
      title: "List evals",
      description:
        "Use this tool to see the evals of the project. An eval has a dataset of cases and the scorers that score each case. It returns each eval with its id, name, task id, version number, sandbox, trials, scorer names, and the number of cases.",
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
        const byDataset = Map.groupBy(cases, ({ datasetId }) => datasetId);
        return {
          data: {
            evals: evals.map((definition) => {
              const dataset = byDataset.get(datasetOf(definition)) ?? [];
              const version = currentVersion(definition);
              return {
                evalId: definition.id,
                name: definition.name,
                taskId: definition.taskId,
                version: version.number,
                sandboxName: version.sandboxName,
                trials: version.trials,
                scorers: version.scorers.map(({ name }) => name),
                cases: dataset.length,
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
        "Use this tool to read one eval by its name or id. It returns its newest version: the sandbox, the default params, the trials, and each scorer with its check or its judge question. It also returns the cases of its dataset with the number of the version that counts.",
      keywords: ["evals", "eval definition"],
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
              version: currentRow(evalCase)?.number ?? null,
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
        "Use this tool to create an eval: a name, a task, a runtime (a sandbox, pinned or not), a dataset or a new query, params, a matrix, trials and scorers. This tool changes data. With no dataset the eval gets an empty one. It returns the eval id and the version number.",
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
        sandboxVersionId: uuidParam()
          .optional()
          .describe("A pinned version of the sandbox. Omit it for its newest ready version."),
        dataset: datasetNameParam.optional(),
        datasetQuery: datasetQueryParam.optional(),
        matrix: matrixParam.optional(),
        scorers: z
          .array(anyScorerParam)
          .max(20)
          .describe(
            "The scorers: library references, or checks and judges of this eval. A trial passes when every gating scorer passes.",
          ),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        if (params.dataset !== undefined && params.datasetQuery !== undefined) {
          throw invalidParams("Give dataset or datasetQuery, not both.", [
            { path: "datasetQuery", message: "Give dataset or datasetQuery, not both." },
          ]);
        }
        const scorers = await scorersOf(deps, ctx.projectId, params.scorers);
        const datasetId = await datasetIdOf(deps, ctx, params.name, params);
        const content = evalContentSchema.safeParse(
          storable({
            datasetId,
            sandboxName: params.sandboxName ?? null,
            sandboxVersionId: params.sandboxVersionId ?? null,
            params: params.params ?? {},
            ...(params.matrix ? { matrix: params.matrix } : {}),
            ...(params.trials ? { trials: params.trials } : {}),
            scorers,
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
          data: { evalId: created.id, name: created.name, version: 1 },
          hint: problem
            ? `${problem} The eval is saved.`
            : `Call evals_create_case with eval "${created.name}" to add cases.`,
        };
      },
    }),
    defineOperation({
      id: "evals_edit",
      domain: "evals",
      title: "Edit an eval",
      description:
        "Use this tool to change an eval: its name, task, runtime, dataset, params, matrix, trials or scorers. This tool changes data: a change of content adds a version, and a started run keeps its own. A field that you omit keeps its value. It returns the eval id and the version number.",
      keywords: ["evals", "edit eval", "change eval", "matrix"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        eval: evalParam,
        name: z.string().trim().min(1).max(MAX_EVAL_NAME_CHARS).optional(),
        taskId: z.string().trim().min(1).max(200).nullable().optional(),
        sandboxName: z.string().trim().min(1).max(200).optional(),
        sandboxVersionId: uuidParam()
          .nullable()
          .optional()
          .describe("A pinned version, or null for the newest ready version."),
        dataset: datasetNameParam.optional(),
        datasetQuery: datasetQueryParam.optional(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        matrix: matrixParam.optional(),
        trials: z.number().int().min(1).max(MAX_TRIALS).optional(),
        scorers: z.array(anyScorerParam).min(1).max(20).optional(),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const found = await findEvalOf(deps, ctx.projectId, params.eval);
        if (!found) throw notFound("eval");
        const version = currentVersion(found);
        const name = params.name ?? found.name;
        const datasetId =
          params.dataset !== undefined || params.datasetQuery !== undefined
            ? await datasetIdOf(deps, ctx, name, params)
            : version.datasetId;
        const content = evalContentSchema.safeParse(
          storable({
            datasetId,
            sandboxName: params.sandboxName ?? version.sandboxName,
            sandboxVersionId:
              params.sandboxVersionId === undefined
                ? version.sandboxVersionId
                : params.sandboxVersionId,
            params: params.params ?? version.params,
            matrix: params.matrix ?? version.matrix,
            trials: params.trials ?? version.trials,
            scorers: params.scorers
              ? await scorersOf(deps, ctx.projectId, params.scorers)
              : version.scorers,
          }),
        );
        if (!content.success) throw contentRefusal(content.error);
        const saved = await deps.actions().evals.update(
          ctx.projectId,
          found.id,
          {
            name,
            taskId: params.taskId === undefined ? found.taskId : params.taskId,
            content: content.data,
          },
          version.id,
          { userId: requester(ctx.auth), now: deps.now() },
        );
        if (saved === "not_found") throw notFound("eval");
        if (saved === "dataset_not_found") throw notFound("dataset");
        if (saved === "changed" || saved === "name_taken") {
          throw new McpOperationError(
            "conflict",
            saved === "changed"
              ? "Another change came first. Read the eval again."
              : "Another eval of the project has this name.",
            { reason: saved },
          );
        }
        const now = currentVersion(saved);
        return {
          data: { evalId: saved.id, name: saved.name, version: now.number },
          hint:
            now.id === version.id
              ? "Nothing changed: the content is the same."
              : `Version ${now.number} is saved. The next run uses it.`,
        };
      },
    }),
    defineOperation({
      id: "evals_list_cases",
      domain: "evals",
      title: "List eval cases",
      description:
        "Use this tool to see the cases of the datasets of the project, or of one eval. It returns each case with its id, name, eval id, labels and the number of the version that counts. Each case counts in an eval run: the newest version of each.",
      keywords: ["evals", "eval cases"],
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
        if (created === "dataset_not_fixed") throw notFixed();
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
        "Use this tool to start a run of one eval (eval), or one run for each eval. This tool changes data: it starts VM runs. A run can change, for itself only, the dataset, added rows, the scorers, the runtime version, the params, a matrix and the trials. It returns each run id and its state.",
      keywords: ["evals", "start eval run", "matrix"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({
        ...projectScoped,
        eval: evalParam.optional().describe("The eval to run. Omit it to run each eval."),
        evals: z
          .array(evalParam)
          .min(1)
          .max(100)
          .optional()
          .describe("The evals to run, one run each (names or ids). Omit it to run each eval."),
        sandboxVersion: z
          .union([z.literal("latest"), uuidParam()])
          .optional()
          .describe(
            "A runtime version id, or latest. It applies only to the evals of its sandbox. Omit it to use the runtime of each eval.",
          ),
        dataset: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Another dataset (name or id), for these runs only."),
        trials: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRIALS)
          .optional()
          .describe("The runs of each row. Omit it to use the trials of each eval."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .default({})
          .describe(
            "Values for the params of the runtime. They go over the defaults of each eval.",
          ),
        matrix: matrixParam.optional(),
        rows: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("turns"), turnIds: z.array(uuidParam()).min(1).max(100) }),
            z.object({
              kind: z.enum(["last_traces", "auto"]),
              limit: z.number().int().min(1).max(500),
            }),
          ])
          .optional()
          .describe(
            "Rows for this run only (one eval): chosen trace turns, the last N traces, or Ratel's choice. They copy captured text.",
          ),
        scorers: z
          .array(refScorerParam)
          .min(1)
          .max(20)
          .optional()
          .describe("Library scorers for this run only (one eval), in place of the eval's."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        if (params.eval !== undefined && params.evals !== undefined) {
          throw invalidParams("Give eval or evals, not both.", [
            { path: "evals", message: "Give eval or evals, not both." },
          ]);
        }
        if ((params.rows || params.scorers) && params.eval === undefined) {
          throw invalidParams("rows and scorers change one run: give eval.", [
            { path: "eval", message: "rows and scorers change one run: give eval." },
          ]);
        }
        const organizationId = ctx.organizationId ?? (await deps.organizationIdOf(ctx.projectId));
        if (!organizationId) throw notFound("project");
        const changes = {
          ...(params.sandboxVersion === undefined ? {} : { sandboxVersion: params.sandboxVersion }),
          ...(params.dataset === undefined ? {} : { dataset: params.dataset }),
          ...(params.trials === undefined ? {} : { trials: params.trials }),
          ...(params.matrix === undefined ? {} : { matrix: params.matrix }),
          ...(Object.keys(params.params).length === 0 ? {} : { params: params.params }),
        };
        const extra =
          params.rows || params.scorers
            ? await runChanges(
                ctx.projectId,
                await actorOf(deps, ctx),
                {
                  ...(params.rows ? { rows: params.rows } : {}),
                  ...(params.scorers
                    ? {
                        scorers: params.scorers.map((scorer, index) => ({
                          ...scorer,
                          id: `run-${index + 1}`,
                        })),
                      }
                    : {}),
                },
                deps.actions(),
              )
            : null;
        if (extra && !extra.ok) {
          throw new McpOperationError(
            extra.reason === "no_content_access" ? "forbidden" : "invalid_params",
            extra.message,
            { reason: extra.reason },
          );
        }
        const result = await deps.startRuns(
          { projectId: ctx.projectId, organizationId },
          {
            ...(params.eval ? { eval: params.eval } : {}),
            ...(params.evals ? { evals: params.evals } : {}),
            startedBy: requester(ctx.auth),
            // A query dataset copies captured text into the run. The run start refuses it for a
            // key with no `content:read` scope, and reads the opt-in of the project itself.
            mayCopyContent: credentialMayReadContent(ctx.auth),
            changes: { ...changes, ...(extra?.changes ?? {}) },
          },
        );
        if (!result.ok) throw startRefusal(result);
        const runs = result.runs.map((part) => {
          if (!part.ok) {
            return { eval: part.eval, error: part.reason, message: part.message };
          }
          const { experiment } = part;
          deps.advance(experiment);
          return {
            eval: part.eval,
            runId: experiment.id,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            variants: experiment.variants.length,
            cases: experiment.caseVersions.length,
            trials:
              experiment.caseVersions.reduce(
                (sum, frozen) => sum + trialsOfCase(experiment, frozen),
                0,
              ) * Math.max(1, experiment.variants.length),
            ...(part.note ? { note: part.note } : {}),
          };
        });
        const first = runs.find((run) => "runId" in run);
        return {
          data: { runs },
          hint: first
            ? `The runs started. Call evals_get_run with runId "${first.runId}" and the other run ids. It waits up to ${RUN_WAIT_MS / 1000} seconds for a run to end. Call it again while the state is running.`
            : "No run started. Each part says why.",
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
        // A run of one eval is the baseline when it is the pin of its eval.
        const evalIds = [...new Set(experiments.flatMap(({ evalId }) => evalId ?? []))];
        const pins = new Set(
          (await Promise.all(evalIds.map((id) => deps.getBaseline(ctx.projectId, id)))).flatMap(
            (pin) => pin?.experimentId ?? [],
          ),
        );
        if (baseline) pins.add(baseline.experimentId);
        const runs = await Promise.all(
          experiments.map(async (experiment) => ({
            runId: experiment.id,
            evalId: experiment.evalId,
            state: experiment.state,
            sandboxVersionId: experiment.sandboxVersionId,
            sandboxName: experiment.sandboxName,
            counts: countTrials(await deps.trials(experiment.id)),
            baseline: pins.has(experiment.id),
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
          deps.pinnedRun(ctx.projectId, experiment.evalId),
        ]);
        const view = await runView(deps, ctx.projectId, experiment, trials, readable);
        return {
          data: {
            ...view.data,
            ...suiteView(suiteTable({ experiment, trials }, baseline)),
            ...runFields(experiment, trials, baseline),
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
            // The reason of a failed trial is the error text of the agent: captured content.
            reason: readable || trial.result === "invalid" ? trial.reason : null,
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
        "Use this tool to make a completed eval run the baseline of its eval. This tool changes data: it replaces the pinned baseline of that eval. It returns the baseline run id and the time of the pin. evals_compare uses this baseline when you give no baselineRunId.",
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
      id: "evals_unpin_baseline",
      domain: "evals",
      title: "Unpin the eval baseline",
      description:
        "Use this tool to remove the pin of a baseline run. This tool changes data: the eval of the run has no baseline until another run is pinned, and its runs show no delta. It returns the run id that was the baseline.",
      keywords: ["evals", "unpin baseline"],
      scope: "project",
      mutates: true,
      apiKeyScope: "evals:write",
      params: z.object({ ...projectScoped, runId: runIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        if (!(await deps.unpinBaseline(ctx.projectId, params.runId))) {
          throw notFound("pinned baseline run");
        }
        return {
          data: { unpinnedRunId: params.runId },
          hint: "Call evals_pin_baseline with a completed runId to pin another baseline.",
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
  const found = rowOfSandboxRun(run);
  if (!found.ok) throw new McpOperationError("conflict", found.message, { reason: "run_active" });
  return { ...found, traceId: run.traceId ?? null };
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
      const scorers = content.scorers.map((scorer) => `"${scorer.name}"`).join(", ") || "none";
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

function notFixed(): McpOperationError {
  return new McpOperationError(
    "conflict",
    "The dataset of the eval is a query: a run resolves its rows. Add the row to a fixed dataset.",
    { reason: "dataset_not_fixed" },
  );
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
  if (created === "dataset_not_found") throw notFound("dataset");
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
  no_content_access: "forbidden",
  query_failed: "invalid_params",
  too_many_rows: "invalid_params",
  invalid_scorers: "invalid_params",
  shared_dataset: "conflict",
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

/** The scorers of a request: a library reference gets the definition that the library has now. */
async function scorersOf(
  deps: EvalsOperationDeps,
  projectId: string,
  scorers: ReadonlyArray<z.output<typeof anyScorerParam>>,
): Promise<EvalScorer[]> {
  const inline = scorers.flatMap((scorer) => ("ref" in scorer ? [] : [evalScorer(scorer)]));
  const refs = scorers.flatMap((scorer) =>
    "ref" in scorer ? [{ ...scorer, id: randomUUID() }] : [],
  );
  if (refs.length === 0) return inline;
  const resolved = await withDefinitions(projectId, refs, deps.actions());
  if (!resolved.ok) {
    throw new McpOperationError("invalid_params", resolved.message, { reason: resolved.reason });
  }
  // In the order of the request.
  let next = 0;
  let own = 0;
  return scorers.map((scorer) =>
    "ref" in scorer ? (resolved.scorers[next++] as EvalScorer) : (inline[own++] as EvalScorer),
  );
}

/** The dataset of an eval: one named, a new query dataset, or none (null: its own fixed one). */
async function datasetIdOf(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
  evalName: string,
  params: {
    dataset?: string | undefined;
    datasetQuery?: z.output<typeof datasetQueryParam> | undefined;
  },
): Promise<string | null> {
  if (params.dataset === undefined && params.datasetQuery === undefined) return null;
  const actions = deps.actions();
  let choice: { datasetId: string } | { query: z.output<typeof datasetQuerySchema> };
  if (params.dataset !== undefined) {
    const byName = await actions.datasets.getByName(ctx.projectId, params.dataset);
    const id = byName?.id ?? (z.uuid().safeParse(params.dataset).success ? params.dataset : null);
    if (!id) throw notFound("dataset");
    choice = { datasetId: id };
  } else {
    const query = datasetQuerySchema.safeParse(params.datasetQuery);
    if (!query.success) {
      const message = query.error.issues[0]?.message ?? "The query is not valid.";
      throw invalidParams(message, [{ path: "datasetQuery", message }]);
    }
    choice = { query: query.data };
  }
  const found = await datasetFor(
    ctx.projectId,
    await actorOf(deps, ctx),
    choice,
    evalName,
    actions,
  );
  if (!found.ok) {
    if (found.reason === "not_found") throw notFound("dataset");
    throw new McpOperationError("invalid_params", found.message, { reason: found.reason });
  }
  return found.datasetId;
}

async function findEvalOf(
  deps: EvalsOperationDeps,
  projectId: string,
  wanted: string,
): Promise<EvalDefinition | null> {
  const byName = await deps.getEvalByName(projectId, wanted);
  if (byName) return byName;
  return z.uuid().safeParse(wanted).success ? deps.getEval(projectId, wanted) : null;
}

async function actorOf(
  deps: EvalsOperationDeps,
  ctx: Pick<OperationContext, "auth" | "projectId">,
): Promise<Actor> {
  return { by: requester(ctx.auth), mayReadContent: await deps.mayReadContent(ctx) };
}
