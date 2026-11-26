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
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import {
  type ComparisonResult,
  compareWithBaseline,
  type PinResult,
  pinBaseline,
} from "@/lib/views/evals/baseline";
import { baselineDeps } from "@/lib/views/evals/baseline-deps";
import {
  approvalProblem,
  approvedVersion,
  type CaseContent,
  type CaseVersion,
  caseContentSchema,
  draftVersion,
  type EvalCase,
} from "@/lib/views/evals/domain/case";
import { type CompareRefusal, type Comparison, compare } from "@/lib/views/evals/domain/compare";
import {
  countTrials,
  DEFAULT_TRIALS,
  type Experiment,
  MAX_TRIALS,
  type Trial,
  type TrialEvidence,
} from "@/lib/views/evals/domain/experiment";
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
  /** The newest first. */
  listCases(projectId: string): Promise<EvalCase[]>;
  getCase(projectId: string, caseId: string): Promise<EvalCase | null>;
  createCase(input: NewCase): Promise<EvalCase>;
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
  listCases: (projectId) => createDrizzleCaseStore(getDb()).list(projectId),
  getCase: (projectId, caseId) => createDrizzleCaseStore(getDb()).get(projectId, caseId),
  createCase: (input) => createDrizzleCaseStore(getDb()).create(input),
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
      id: "evals_list_cases",
      domain: "evals",
      title: "List eval cases",
      description:
        "Use this tool to see the eval cases of the project. It returns each case with its name, labels, approved version number and draft. Only an approved case counts in an eval run.",
      keywords: ["evals", "eval cases", "dataset"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireEvals(deps, ctx.projectId);
        const read = capRows(await deps.listCases(ctx.projectId), CASES_SHOWN);
        const cases = read.rows.map((evalCase) => ({
          caseId: evalCase.id,
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
        "Use this tool to read one eval case. It returns the input, the expected output, the scorers and the state of the newest version, and the version that counts in an eval run.",
      keywords: ["evals", "case detail", "expected output"],
      scope: "project",
      mutates: false,
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
        "Use this tool to save an input as an eval case, for example a sandbox run with a bad answer. This tool changes data: it adds a draft case. Give sandboxRunId to copy the input and answer of that run. A case needs a gating scorer before approval.",
      keywords: ["evals", "save as case", "new case"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("A short name that says what the case tests."),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        sandboxRunId: uuidParam()
          .optional()
          .describe("A sandbox run to copy. Its input becomes the input of the case."),
        input: z
          .unknown()
          .optional()
          .describe("The input of the agent. Give this or sandboxRunId."),
        expectedOutput: z
          .string()
          .max(20_000)
          .optional()
          .describe("The answer that is correct, as text. A judge reads it."),
        scorers: z
          .array(scorerParam)
          .max(20)
          .optional()
          .describe("The scorers. A trial passes when every gating scorer passes."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const source = params.sandboxRunId
          ? await runSource(deps, ctx.projectId, params.sandboxRunId)
          : null;
        const input = source ? source.input : params.input;
        if (input === undefined || input === null) {
          throw invalidParams("Give an input or a sandboxRunId.", [
            { path: "input", message: "Give an input or a sandboxRunId." },
          ]);
        }
        const content = caseContentSchema.safeParse(
          storable({
            input,
            expectedOutput: params.expectedOutput ?? null,
            scorers: (params.scorers ?? []).map(caseScorer),
          }),
        );
        if (!content.success) throw contentRefusal(content.error);
        const created = await deps.createCase({
          projectId: ctx.projectId,
          name: params.name,
          labels: [...new Set(params.labels ?? [])],
          content: content.data,
          createdBy: requester(ctx.auth),
          ...(source ? { source: { turnId: null, output: source.output } } : {}),
        });
        const draft = draftVersion(created);
        const problem = approvalProblem(content.data);
        return {
          data: {
            caseId: created.id,
            name: created.name,
            draftVersion: draft?.number ?? null,
            state: "draft",
            ...(problem ? { approvalProblem: problem } : {}),
          },
          hint: problem
            ? `${problem} The case is saved as a draft. Create the case again with a gating scorer.`
            : `Call evals_approve_case with caseId "${created.id}" to make the case count in an eval run.`,
        };
      },
    }),
    defineOperation({
      id: "evals_approve_case",
      domain: "evals",
      title: "Approve an eval case",
      description:
        "Use this tool to approve the draft of an eval case. This tool changes data: the draft becomes the version that counts in the next eval run. It refuses a draft with no input or no gating scorer.",
      keywords: ["evals", "approve case"],
      scope: "project",
      mutates: true,
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
        "Use this tool to run every approved eval case against a sandbox version. This tool changes data: it starts VM runs. It returns the eval run id at once. Poll evals_get_run until the state is completed.",
      keywords: ["evals", "start eval run"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        sandboxVersion: z
          .union([z.literal("latest"), uuidParam()])
          .default("latest")
          .describe("A sandbox version id, or latest for the newest ready version."),
        trials: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRIALS)
          .default(DEFAULT_TRIALS)
          .describe("The runs of each case."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .default({})
          .describe("Values for the params that the sandbox version declares."),
      }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const organizationId = ctx.organizationId ?? (await deps.organizationIdOf(ctx.projectId));
        if (!organizationId) throw notFound("project");
        const result = await deps.startExperiment(
          { projectId: ctx.projectId, organizationId },
          {
            sandboxVersion: params.sandboxVersion,
            trialsPerCase: params.trials,
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
            cases: experiment.caseVersions.length,
            trials: experiment.caseVersions.length * experiment.trialsPerCase,
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
        "Use this tool to find eval runs of the project, newest first. It returns each run with its state, sandbox version, raw pass, fail and invalid counts, and which run is the pinned baseline.",
      keywords: ["evals", "eval runs"],
      scope: "project",
      mutates: false,
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
        "Use this tool to read an eval run. A running run is awaited up to 20 seconds. It returns the state and the raw counts, and for each case its input, the output of each trial, the trial results and the scorer results.",
      keywords: ["evals", "eval results", "raw counts"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, runId: runIdParam }),
      async execute(ctx, params) {
        await requireEvals(deps, ctx.projectId);
        const experiment = await waitForEnd(
          deps,
          ctx.projectId,
          await deps.getExperiment(ctx.projectId, params.runId),
        );
        if (!experiment) throw notFound("eval run");
        const [trials, readable] = await Promise.all([
          deps.trials(experiment.id),
          deps.mayReadContent(ctx),
        ]);
        const view = await runView(deps, ctx.projectId, experiment, trials, readable);
        return {
          data: view.data,
          ...(view.truncated ? { truncated: true } : {}),
          hint: !readable
            ? CONTENT_WITHHELD_HINT
            : experiment.state === "running"
              ? `The eval run is still running after a wait of ${RUN_WAIT_MS / 1000} seconds. Call evals_get_run with runId "${experiment.id}" again.`
              : `The eval run is completed. Call evals_compare with runId "${experiment.id}" to compare it with the baseline, or evals_pin_baseline to make it the baseline.`,
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
        "Use this tool to compare an eval run with the pinned baseline, or with baselineRunId. It returns the verdict, the rule that decided it, and the changed cases with the outputs of both runs. It refuses runs whose scorers differ and says why.",
      keywords: ["evals", "regression", "verdict"],
      scope: "project",
      mutates: false,
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
        "Use this tool to make a completed eval run the baseline of the project. This tool changes data: it replaces the pinned baseline. evals_compare uses the baseline when no baselineRunId is given.",
      keywords: ["evals", "pin baseline"],
      scope: "project",
      mutates: true,
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
    scorers: version.scorers.map(({ name, gating, definition }) => ({
      name,
      gating,
      kind: definition.kind,
      ...(definition.kind === "check"
        ? { check: definition.config }
        : { question: readable ? definition.config.prompt : null }),
    })),
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
  };
}

function caseScorer(scorer: z.output<typeof scorerParam>): CaseContent["scorers"][number] {
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
    unchangedCases: comparison.cases
      .filter(({ change }) => change === "unchanged")
      .map(({ caseId, name, candidate }) => ({ caseId, name, status: candidate?.status ?? null })),
    ...(readable ? {} : { contentWithheld: true }),
  };
}
