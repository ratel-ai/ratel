import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { type BoundReadDb, withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  latestExplorerRun as latestExplorerRunFn,
  listCousage as listCousageFn,
  listIntentTools as listIntentToolsFn,
  listMergeCandidates as listMergeCandidatesFn,
  listTransitions as listTransitionsFn,
} from "@/lib/readings/tool-explorer/queries";
import type { ExplorerSummary } from "@/lib/readings/tool-explorer/types";
import { loadTopicPatterns } from "@/lib/readings/topics/queries";
import {
  latestSignalRun as latestSignalRunFn,
  STALE_RUN_MS,
} from "@/lib/readings/trace-signals/signals/queries";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";
import { getRuntimeToolDefinitions as getRuntimeToolDefinitionsFn } from "@/lib/synthesis/catalog/runtime-reads";
import { pickCandidates } from "@/lib/synthesis/match-quality/deficits";
import { buildReplayCases } from "@/lib/synthesis/match-quality/labels";
import {
  getLatestRun as getLatestMatchQualityRunFn,
  loadLabels as loadLabelsFn,
  loadReplayHistory as loadReplayHistoryFn,
} from "@/lib/synthesis/match-quality/queries";
import { loadToolCorpus as loadToolCorpusFn } from "@/lib/synthesis/match-quality/service";
import type { IntentFact } from "@/lib/synthesis/tool-crafter/candidates";
import type { IntentPatternFact } from "@/lib/synthesis/tool-crafter/intent-merge";
import {
  type CraftRunReads,
  type ExplorerReading,
  runToolCraft as runToolCraftFn,
} from "@/lib/synthesis/tool-crafter/pipeline";
import {
  type CraftTrigger,
  enqueueCraftJob as enqueueCraftJobFn,
  failCraftRun as failCraftRunFn,
  finishCraftRun as finishCraftRunFn,
  reapStaleCraftRuns as reapStaleCraftRunsFn,
  startCraftRun as startCraftRunFn,
} from "@/lib/synthesis/tool-crafter/queries";
import type { JsonSchemaObject, SourceTool } from "@/lib/synthesis/tool-crafter/types";

/**
 * The `craft_tools` job: one crafting run for one project, queued after each
 * completed explorer run (`chained`) or by an MCP client (`manual`). Reap a
 * live run a crashed job left behind, claim the project's one live run, read
 * the Explorer and match quality, draft, persist. Any failure fails the run
 * and rethrows so the job runner records it. No model is called; the
 * proposals are rule-drafted suggestions.
 *
 * Owned (ADR-0030): the crafter drafts for every project here, as the explorer
 * runs for every project, so there is no flag gate (upstream's `flag.ts` and
 * `flags-ingest` are gone and `isEnabled` with them). The explorer it reads
 * is the L4 module; its registration fills `exploreSeams.enqueueCraft`.
 */

const logger = getLogger("tool-crafter/job");
const SYSTEM_DISTINCT_ID = "system:tool-crafter";
const TRIGGERS: ReadonlySet<string> = new Set(["chained", "manual"]);

export interface CraftJobPayload {
  trigger: CraftTrigger;
}

/** The payload a job carries; a run queued before triggers were kept reads as manual. */
export function parseCraftPayload(payload: unknown): CraftJobPayload {
  const trigger =
    payload && typeof payload === "object" ? (payload as { trigger?: unknown }).trigger : undefined;
  return {
    trigger:
      typeof trigger === "string" && TRIGGERS.has(trigger) ? (trigger as CraftTrigger) : "manual",
  };
}

export interface CraftJobDeps {
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  reapStale: typeof reapStaleCraftRunsFn;
  startRun: typeof startCraftRunFn;
  failRun: typeof failCraftRunFn;
  finishRun: typeof finishCraftRunFn;
  reads: CraftRunReads;
  run: typeof runToolCraftFn;
  observability: Pick<BackgroundObservability, "trackSystemEvent">;
  /** Queue this job again, when a live run kept it from starting; coalesced with any job already queued. */
  requeue: (projectId: string, trigger: CraftTrigger) => Promise<unknown>;
  now: () => Date;
}

const EMPTY_READING: ExplorerReading = {
  runId: null,
  windowDays: 0,
  sets: [],
  pairs: [],
  edges: [],
  nodes: [],
};

/** The Explorer's latest reading: always-together pairs at both scopes, every pair, the transitions, the nodes and the intent join. */
export async function loadExplorerForCraft(projectId: string): Promise<ExplorerReading> {
  const run = await latestExplorerRunFn(projectId, undefined, "completed");
  if (!run) return EMPTY_READING;
  const [
    turnSets,
    sessionSets,
    turnPairs,
    sessionPairs,
    turnNext,
    turnBefore,
    sessionNext,
    sessionBefore,
    signalRun,
    intentRows,
  ] = await Promise.all([
    listMergeCandidatesFn(projectId, { scope: "turn" }),
    listMergeCandidatesFn(projectId, { scope: "session" }),
    listCousageFn(projectId, { scope: "turn", size: 2, limit: 2_000 }),
    listCousageFn(projectId, { scope: "session", size: 2, limit: 2_000 }),
    listTransitionsFn(projectId, { scope: "turn", kind: "next", limit: 2_000 }),
    listTransitionsFn(projectId, { scope: "turn", kind: "before", limit: 2_000 }),
    listTransitionsFn(projectId, { scope: "session", kind: "next", limit: 2_000 }),
    listTransitionsFn(projectId, { scope: "session", kind: "before", limit: 2_000 }),
    latestSignalRunFn(projectId, undefined, "completed"),
    listIntentToolsFn(projectId, { scope: "turn", limit: 2_000 }),
  ]);
  const summary = (run.summary ?? null) as ExplorerSummary | null;
  // The asks, turn scope: one fact per intent with its shares, sure hops and first calls.
  const intents = new Map<string, IntentFact>();
  for (const r of intentRows) {
    let fact = intents.get(r.intentId);
    if (!fact) {
      fact = {
        intentId: r.intentId,
        text: r.intentText,
        units: r.intentUnits,
        tools: [],
        edges: summary?.intentEdges?.turn?.[r.intentId] ?? [],
        firsts: summary?.intentFirsts?.turn?.[r.intentId] ?? [],
        calls: summary?.intentCalls?.turn?.[r.intentId] ?? 0,
      };
      intents.set(r.intentId, fact);
    }
    fact.tools.push({ toolId: r.toolId, n: r.n });
  }
  // Agent health's mined workflows, read for their order and health only.
  const workflows = (
    (signalRun?.summary as { workflows?: StoredWorkflows } | null)?.workflows?.items ?? []
  ).map((w) => ({
    id: w.id,
    typicalOrder: w.typicalOrder,
    orderStability: w.orderStability,
    runs: w.runs,
    medianMs: w.health.medianMs,
    medianModelCalls: w.health.model?.medianModelCalls ?? null,
    medianCostUsd: w.health.model?.medianCostUsd ?? null,
  }));
  // Turn-scope pairs first: a pair bound inside one request is the stronger merge.
  return {
    runId: run.id,
    windowDays: run.windowDays,
    sets: [...turnSets, ...sessionSets],
    pairs: [...turnPairs, ...sessionPairs],
    edges: [...turnNext, ...turnBefore, ...sessionNext, ...sessionBefore],
    nodes: summary?.nodes ?? [],
    reliability: summary?.reliability,
    workflows,
    intents: [...intents.values()],
    turns: summary?.units.turn.units ?? 0,
  };
}

/**
 * Each live intent's stored tool pattern (the topics job's), for the
 * intents' own merges. Extra to a run: bounded by a statement timeout, and a
 * read that fails is logged and reported and reads as none, so the run goes
 * on with every other rule.
 */
export async function loadIntentPatternsForCraft(
  projectId: string,
  db?: BoundReadDb,
): Promise<IntentPatternFact[]> {
  const operation = "craft_intent_patterns";
  return loadOrFallback<IntentPatternFact[]>({
    operation,
    distinctId: `project:${projectId}`,
    fallback: [],
    load: async () => {
      const rows = await withStatementTimeout((tx) => loadTopicPatterns(projectId, tx), {
        operation,
        ...(db ? { db } : {}),
      });
      return rows.map((row) => ({ topicId: row.topicId, turns: row.turns, pattern: row.pattern }));
    },
  });
}

/** The labelled searches and corpus match quality's backtest replays; null without a run. */
export async function loadBacktestForCraft(projectId: string) {
  const run = await getLatestMatchQualityRunFn(projectId);
  if (!run || !run.tunedArm) return null;
  const [items, labels, corpus] = await Promise.all([
    loadReplayHistoryFn(projectId),
    loadLabelsFn(projectId),
    loadToolCorpusFn(projectId),
  ]);
  return { corpus, cases: buildReplayCases(items, labels, run.tunedArm, run.baselineArm ?? "") };
}

export async function loadSourcesForCraft(projectId: string): Promise<SourceTool[]> {
  const rows = await getRuntimeToolDefinitionsFn(projectId);
  return rows.map((row) => ({
    id: row.entryId,
    name: row.name,
    description: row.description,
    searchableDescription: row.searchableDescriptionOverride ?? row.searchableDescription ?? null,
    inputSchema: (row.inputSchema as JsonSchemaObject | null) ?? null,
  }));
}

/** Match quality's deficits from its stored history, ranked worst first; [] without a run. */
export async function loadDeficitsForCraft(projectId: string) {
  const run = await getLatestMatchQualityRunFn(projectId);
  if (!run || !run.tunedArm) return [];
  const items = await loadReplayHistoryFn(projectId);
  return pickCandidates(items, run.tunedArm, run.baselineArm ?? "");
}

function defaultDeps(): CraftJobDeps {
  return {
    getOrganizationByProjectId: getOrganizationByProjectIdFn,
    reapStale: reapStaleCraftRunsFn,
    startRun: startCraftRunFn,
    failRun: failCraftRunFn,
    finishRun: finishCraftRunFn,
    reads: {
      loadExplorer: loadExplorerForCraft,
      loadSources: loadSourcesForCraft,
      loadDeficits: loadDeficitsForCraft,
      loadBacktest: loadBacktestForCraft,
      loadIntentPatterns: (projectId) => loadIntentPatternsForCraft(projectId),
    },
    run: runToolCraftFn,
    observability: createBackgroundObservability(),
    requeue: (projectId, trigger) => enqueueCraftJobFn(projectId, undefined, trigger),
    now: () => new Date(),
  };
}

export type CraftJobOutcome = "crafted" | "busy";

export interface CraftJobResult {
  outcome: CraftJobOutcome;
  runId: string | null;
  proposals: number;
  declinedReason: string | null;
}

export async function craftProjectTools(
  projectId: string,
  overrides: Partial<CraftJobDeps> = {},
  payload: CraftJobPayload = { trigger: "manual" },
): Promise<CraftJobResult> {
  const deps = { ...defaultDeps(), ...overrides };
  // The organization is read for the same reason the explorer reads it: a project that has
  // none is gone, and the drafting that follows must not run on its tables.
  const organization = await deps.getOrganizationByProjectId(projectId);
  if (!organization) {
    logger.info({ project_id: projectId }, "tool craft run skipped: no organization");
    return { outcome: "busy", runId: null, proposals: 0, declinedReason: null };
  }
  const startedAt = deps.now();
  await deps.reapStale(
    projectId,
    new Date(startedAt.getTime() - STALE_RUN_MS),
    undefined,
    startedAt,
  );
  const run = await deps.startRun(
    { projectId, trigger: payload.trigger, explorerRunId: null },
    undefined,
    startedAt,
  );
  if (!run) {
    // The queued index coalesces queued jobs only; one that lands beside a live run is queued again for the next drain.
    try {
      const queued = await deps.requeue(projectId, payload.trigger);
      logger.info(
        { project_id: projectId, trigger: payload.trigger, coalesced: queued === null },
        "tool craft run deferred behind a live run",
      );
    } catch (err) {
      logger.error(
        { err, project_id: projectId, trigger: payload.trigger },
        "tool craft requeue failed",
      );
      reportServerException(err, `project:${projectId}`, { operation: "craft_tools_requeue" });
    }
    return { outcome: "busy", runId: null, proposals: 0, declinedReason: null };
  }

  const base = { project_id: projectId, run_id: run.id, trigger: payload.trigger };
  try {
    const result = await deps.run(projectId, deps.reads);
    const finishedAt = deps.now();
    const finished = await deps.finishRun({
      runId: run.id,
      projectId,
      explorerRunId: result.explorerRunId,
      proposals: result.proposals,
      candidates: result.candidates as unknown as Record<string, unknown>[],
      declinedReason: result.declinedReason,
      now: finishedAt,
    });
    const fields = {
      ...base,
      proposals: finished.created,
      proposals_dismissed_before: finished.dismissed,
      candidates: result.candidates.length,
      declined_reason: result.declinedReason,
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    };
    logger.info(fields, "tool craft run completed");
    await deps.observability.trackSystemEvent("tool_craft_run_completed", SYSTEM_DISTINCT_ID, {
      object_action: "tool_craft_run_completed",
      ...fields,
    });
    return {
      outcome: "crafted",
      runId: run.id,
      proposals: finished.created,
      declinedReason: result.declinedReason,
    };
  } catch (err) {
    const failedAt = deps.now();
    await deps.failRun(
      run.id,
      err instanceof Error ? err.message : String(err),
      undefined,
      failedAt,
    );
    const fields = { ...base, duration_ms: Math.max(0, failedAt.getTime() - startedAt.getTime()) };
    logger.error({ ...fields, err }, "tool craft run failed");
    await deps.observability.trackSystemEvent("tool_craft_run_failed", SYSTEM_DISTINCT_ID, {
      object_action: "tool_craft_run_failed",
      ...fields,
    });
    throw err;
  }
}
