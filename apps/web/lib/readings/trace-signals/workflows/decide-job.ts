import { loadToolCorpus as loadToolCorpusFn } from "@/lib/ingest/runtime-catalog/inventory";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  configured,
  resolveDecisionEngine,
  usdPerInputToken,
} from "@/lib/readings/decisions/engine";
import {
  type CorpusEntry,
  identityFingerprint,
  type JudgeEngine,
  type JudgeVerdict,
} from "@/lib/readings/decisions/judge";
import { openaiJudgeEngine } from "@/lib/readings/decisions/openai-judge";
import {
  type AskGroup,
  aggregateDecisions,
  askHash,
  type DecisionWorkflow,
  decisionCases,
  decisionOptions,
  NO_TOOL_OPTION,
  NONE_OPTION_ID,
  optionsHash,
  WORKFLOW_FRAMING,
} from "./decide";
import {
  loadRecentAskGroups as loadRecentAskGroupsFn,
  loadVerdicts as loadVerdictsFn,
  saveInsights as saveInsightsFn,
  saveVerdicts as saveVerdictsFn,
  type VerdictRow,
} from "./decide-queries";
import type { WorkflowLabels } from "./name";

/**
 * The decision step of the `label_workflows` job: put the project's recent captured asks
 * to the choice model, cache each verdict by (ask, option set), and store the folded
 * result for the page. Without a key it does nothing. A per-job token cap bounds the
 * spend; a rejected key or an outage is logged and leaves the previous insights in place.
 *
 * Owned (ADR-0030): OpenAI is the one decision engine in this edition, the tool corpus
 * is read from the runtime catalog, and the deps take an `env` so tests pass none.
 */

const DAY_MS = 86_400_000;
export const DECIDE_WINDOW_DAYS = 30;
export const MAX_ASKS_PER_JOB = Math.floor(envNumber("TRACE_WORKFLOW_MAX_ASKS", 300));
/** About $0.30 at the engine's input price; a full job of 300 asks uses a fraction of it. */
export const DECIDE_MAX_INPUT_TOKENS = Math.floor(
  envNumber("TRACE_WORKFLOW_MAX_JUDGE_TOKENS", 3_000_000),
);
const logger = getLogger("trace-signals/decide-workflows");

type Env = Record<string, string | undefined>;

export interface DecideDeps {
  judge: JudgeEngine | null;
  /** The decision engine with its tuned tool framing, for the "does any tool do this" check; null skips it. */
  toolJudge: JudgeEngine | null;
  /** The ceiling the token cap puts on one job's spend at the engine's list price, for the log. */
  maxUsd?: number;
  loadToolCorpus: (projectId: string) => Promise<CorpusEntry[]>;
  loadRecentAskGroups: typeof loadRecentAskGroupsFn;
  loadVerdicts: typeof loadVerdictsFn;
  saveVerdicts: typeof saveVerdictsFn;
  saveInsights: typeof saveInsightsFn;
  now: () => Date;
}

export interface DecideResult {
  asks: number;
  judged: number;
  cached: number;
  skipped: "no_judge" | "no_workflows" | "no_asks" | "failed" | null;
}

/**
 * The decision engine (`readings/decisions/engine.ts`) with the workflow framing, or with
 * `tools` its tuned tool framing; null without a usable key.
 */
export function workflowJudgeFromEnv(env: Env = process.env, tools = false): JudgeEngine | null {
  const resolved = resolveDecisionEngine(env);
  if (!resolved) return null;
  return openaiJudgeEngine({
    apiKey: resolved.apiKey,
    baseUrl: configured(env.OPENAI_BASE_URL),
    model: configured(env.OPENAI_DECISIONS_MODEL),
    ...(tools ? {} : { framing: WORKFLOW_FRAMING }),
    maxInputTokens: DECIDE_MAX_INPUT_TOKENS,
  });
}

/** The ceiling this job's token cap puts on spend at the engine's list price; undefined without an engine. */
export function decideMaxUsd(env: Env = process.env): number | undefined {
  const resolved = resolveDecisionEngine(env);
  if (!resolved) return undefined;
  return Number((DECIDE_MAX_INPUT_TOKENS * usdPerInputToken(resolved.name)).toFixed(2));
}

export function defaultDecideDeps(env: Env = process.env): DecideDeps {
  return {
    judge: workflowJudgeFromEnv(env),
    toolJudge: workflowJudgeFromEnv(env, true),
    maxUsd: decideMaxUsd(env),
    loadToolCorpus: (projectId) => loadToolCorpusFn(projectId),
    loadRecentAskGroups: loadRecentAskGroupsFn,
    loadVerdicts: loadVerdictsFn,
    saveVerdicts: saveVerdictsFn,
    saveInsights: saveInsightsFn,
    now: () => new Date(),
  };
}

/**
 * For asks no workflow fits: does any catalog tool do what was asked? Cached like the
 * workflow verdicts, keyed by the catalog's identity. The none option rides every
 * question's shortlist, so narrowing a big catalog never drops it.
 */
async function checkTools(
  projectId: string,
  groups: readonly AskGroup[],
  deps: DecideDeps,
): Promise<Map<string, { entryId: string }>> {
  const { toolJudge } = deps;
  if (!toolJudge || groups.length === 0) return new Map();
  const corpus = await deps.loadToolCorpus(projectId);
  if (corpus.length === 0) return new Map();
  const hash = `tools:${identityFingerprint(corpus)}`;
  const cases = decisionCases(groups, [NONE_OPTION_ID]);
  const cached = await deps.loadVerdicts(
    projectId,
    hash,
    cases.map((c) => c.id),
  );
  const missing = cases.filter((c) => !cached.has(c.id));
  const fresh =
    missing.length > 0 ? await toolJudge.judge(missing, [...corpus, NO_TOOL_OPTION]) : [];
  const toolIds = new Set(corpus.map((entry) => entry.entryId));
  await deps.saveVerdicts(
    projectId,
    hash,
    toolJudge.model,
    fresh.map((v) => toRow(v, toolIds)),
  );
  return new Map([...cached, ...fresh.map((v) => [v.id, { entryId: v.entryId }] as const)]);
}

/** A verdict as stored: the chosen option id (a workflow, or a tool for the tool check) in `workflow_id`. */
function toRow(verdict: JudgeVerdict, workflowIds: ReadonlySet<string>): VerdictRow {
  const confidence = verdict.confidence ?? null;
  if (verdict.entryId === NONE_OPTION_ID) {
    return { promptHash: verdict.id, verdict: "none", workflowId: null, confidence };
  }
  if (workflowIds.has(verdict.entryId)) {
    return { promptHash: verdict.id, verdict: "workflow", workflowId: verdict.entryId, confidence };
  }
  return { promptHash: verdict.id, verdict: "unclear", workflowId: null, confidence };
}

export async function decideProjectWorkflows(
  projectId: string,
  workflows: readonly DecisionWorkflow[],
  labels: WorkflowLabels,
  deps: DecideDeps,
): Promise<DecideResult> {
  const { judge } = deps;
  if (!judge) return { asks: 0, judged: 0, cached: 0, skipped: "no_judge" };
  if (workflows.length === 0) return { asks: 0, judged: 0, cached: 0, skipped: "no_workflows" };
  const since = new Date(deps.now().getTime() - DECIDE_WINDOW_DAYS * DAY_MS);
  const groups = await deps.loadRecentAskGroups(projectId, since, MAX_ASKS_PER_JOB);
  if (groups.length === 0) return { asks: 0, judged: 0, cached: 0, skipped: "no_asks" };
  const options = decisionOptions(workflows, labels);
  const hash = optionsHash(options);
  const cases = decisionCases(groups);
  const cached = await deps.loadVerdicts(
    projectId,
    hash,
    cases.map((c) => c.id),
  );
  const missing = cases.filter((c) => !cached.has(c.id));
  const workflowIds = new Set(workflows.map((w) => w.id));
  try {
    const fresh = missing.length > 0 ? await judge.judge(missing, options) : [];
    await deps.saveVerdicts(
      projectId,
      hash,
      judge.model,
      fresh.map((v) => toRow(v, workflowIds)),
    );
    const all = new Map<string, { entryId: string }>([
      ...cached,
      ...fresh.map((v) => [v.id, { entryId: v.entryId }] as const),
    ]);
    const unplaced = groups.filter((g) => all.get(askHash(g))?.entryId === NONE_OPTION_ID);
    const tools = await checkTools(projectId, unplaced, deps);
    await deps.saveInsights(
      projectId,
      aggregateDecisions(groups, all, workflows, tools),
      judge.model,
    );
    logger.info(
      {
        project_id: projectId,
        asks: groups.length,
        judged: fresh.length,
        cached: cached.size,
        max_usd: deps.maxUsd,
      },
      "workflow decisions written",
    );
    return { asks: groups.length, judged: fresh.length, cached: cached.size, skipped: null };
  } catch (err) {
    logger.error({ err, project_id: projectId }, "workflow decisions failed");
    reportServerException(err, `project:${projectId}`, { operation: "decide_workflows" });
    return { asks: groups.length, judged: 0, cached: cached.size, skipped: "failed" };
  }
}
