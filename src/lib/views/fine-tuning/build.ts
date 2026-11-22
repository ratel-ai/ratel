import { z } from "zod";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import type { ModelCall, TurnWindow } from "@/lib/views/eval-gate/calls";
import type { Scorer } from "@/lib/views/task-scorers/types";
import {
  BuildInputSchema,
  DATASET_FAILURE_MESSAGES,
  type Dataset,
  type DatasetFailure,
  datasetSettings,
} from "./domain/dataset";
import { toChatExample } from "./domain/jsonl";
import { frozenOverrides } from "./domain/overrides";
import { emptyCounts } from "./domain/redaction";
import {
  type CallEntry,
  type CandidateTurn,
  compareCalls,
  contentHashOf,
  DatasetRowBuilder,
  emptyDrops,
  forcedEvalGroups,
  splitGroups,
} from "./domain/rows";
import { callMatches, selectorWindow, type UseCase } from "./domain/use-case";
import type {
  BuildFactSource,
  ConsentStore,
  DatasetStore,
  MatchedTurn,
  ModelCallSource,
  TurnFacts,
  UseCaseOverrideStore,
  UseCaseStore,
} from "./ports/store";

/**
 * Building a dataset version (RC-1128). `startDatasetBuild` checks the guards,
 * makes a `building` version and queues the `build_fine_tuning_dataset` job.
 * `runDatasetBuild` is that job: it checks the guards again, reads the use
 * case's turns and their calls in one first pass, then runs the calls through
 * the row pipeline a page at a time, in one global order (capture time, then
 * event id), so the earliest call of a duplicate group stays. Each page's rows
 * and its cursor are stored together, so a run that stops (a deploy, its time
 * budget) resumes after the last stored page. It makes no model call.
 */

export const BUILD_DATASET_JOB = "build_fine_tuning_dataset" as const;
export const FINE_TUNING_ACTOR = "system:fine_tuning";
/** Model calls per page: one page's content stays small in memory. */
export const PAGE_CALLS = 100;
/** The most turns one build reads. */
export const MAX_BUILD_TURNS = 20_000;
/** A run that has spent this long queues the rest as a new job. */
const RUN_DEADLINE_MS = 4 * 60_000;

export type DatasetEvent =
  | { name: "dataset_build_started"; actor: string; projectId: string; dataset: Dataset }
  | { name: "dataset_built"; projectId: string; dataset: Dataset }
  | { name: "dataset_build_failed"; projectId: string; dataset: Dataset; reason: DatasetFailure };

export interface BuildJobPayload {
  datasetId: string;
}

export interface DatasetBuildDeps {
  datasets: DatasetStore;
  useCases: Pick<UseCaseStore, "getUseCase">;
  consents: Pick<ConsentStore, "getActiveConsent">;
  /** The use case's pins and exclusions (RC-1130): a start freezes them into the version's settings. */
  overrides: Pick<UseCaseOverrideStore, "listOverrides">;
  calls: Pick<ModelCallSource, "findClosedTurns" | "turnTraceIds" | "spanNames">;
  facts: BuildFactSource;
  /** `FF_FINE_TUNING` for the project's organization. */
  flagOn: (projectId: string) => Promise<boolean>;
  enqueue: (projectId: string, payload: BuildJobPayload) => Promise<void>;
  /** Records the dataset's source (its use case's first task or intent) in the lineage. */
  recordSource: (projectId: string, dataset: Dataset, useCase: UseCase) => Promise<void>;
  track: (event: DatasetEvent) => Promise<void>;
  now?: () => Date;
  /** The most rows one dataset holds (`FINE_TUNING_MAX_DATASET_ROWS`, default 50,000). */
  rowCap?: number;
  pageCalls?: number;
  /** Stop after this many pages and queue the rest. Default: no page limit, only the time budget. */
  maxPagesPerRun?: number;
}

export type StartResult =
  | { ok: true; dataset: Dataset }
  | { ok: false; reason: DatasetFailure | "invalid"; message: string };

export type RunResult =
  | { built: true; datasetId: string; rows: number; contentHash: string }
  | {
      built: false;
      datasetId?: string;
      reason: DatasetFailure | "invalid_payload" | "not_found" | "not_building" | "continued";
    };

const logger = getLogger("fine-tuning/build");
const PayloadSchema = z.object({ datasetId: z.string().uuid() });

/** The row cap: `FINE_TUNING_MAX_DATASET_ROWS`, a positive integer, default 50,000. */
export function datasetRowCap(env: Record<string, string | undefined> = process.env): number {
  return Math.floor(envNumber("FINE_TUNING_MAX_DATASET_ROWS", 50_000, (n) => n >= 1, env));
}

/** Checks the guards and the input, makes a `building` version and queues its job. */
export async function startDatasetBuild(
  projectId: string,
  useCaseId: string,
  input: unknown,
  actor: string,
  deps: DatasetBuildDeps,
): Promise<StartResult> {
  const refused = await guardRefusal(projectId, deps);
  if (refused) return { ok: false, reason: refused, message: DATASET_FAILURE_MESSAGES[refused] };
  const useCase = await deps.useCases.getUseCase(projectId, useCaseId);
  if (!useCase)
    return {
      ok: false,
      reason: "use_case_not_found",
      message: DATASET_FAILURE_MESSAGES.use_case_not_found,
    };
  const parsed = BuildInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: "invalid",
      message: `${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "Invalid build settings."}`,
    };
  }
  const now = deps.now?.() ?? new Date();
  const overrides = frozenOverrides(await deps.overrides.listOverrides(projectId, useCase.id));
  const settings = datasetSettings(
    useCase.selector,
    parsed.data,
    selectorWindow(useCase.selector, now),
    overrides,
  );
  const dataset = await deps.datasets.createBuilding(projectId, {
    useCaseId: useCase.id,
    settings,
    createdBy: actor,
  });
  await deps.enqueue(projectId, { datasetId: dataset.id });
  logger.info(
    { project_id: projectId, dataset_id: dataset.id, version: dataset.version, outcome: "queued" },
    "dataset build queued",
  );
  await deps.track({ name: "dataset_build_started", actor, projectId, dataset });
  return { ok: true, dataset };
}

/** The `build_fine_tuning_dataset` job. */
export async function runDatasetBuild(
  projectId: string,
  payload: unknown,
  deps: DatasetBuildDeps,
): Promise<RunResult> {
  const parsedPayload = PayloadSchema.safeParse(payload);
  if (!parsedPayload.success) return { built: false, reason: "invalid_payload" };
  const datasetId = parsedPayload.data.datasetId;
  const dataset = await deps.datasets.getDataset(projectId, datasetId);
  if (!dataset) return { built: false, datasetId, reason: "not_found" };
  if (dataset.status !== "building") return { built: false, datasetId, reason: "not_building" };

  const refused = await guardRefusal(projectId, deps);
  if (refused) return fail(projectId, dataset, refused, deps);
  const useCase = await deps.useCases.getUseCase(projectId, dataset.useCaseId);
  if (!useCase) return fail(projectId, dataset, "use_case_not_found", deps);

  const startedAt = Date.now();
  const settings = dataset.settings;
  const plan = await planBuild(projectId, settings, deps);
  const builder = new DatasetRowBuilder(settings, {
    scorersByTask: plan.scorersByTask,
    // Frozen at the start: a pin or an exclusion set later applies to the next version.
    pinned: new Set(settings.overrides?.pinned ?? []),
    excluded: new Set(settings.overrides?.excluded ?? []),
    groups: plan.groups,
    forcedEval: forcedEvalGroups(plan.groups, plan.evalCases),
  });

  // Resume: the stored rows rebuild the dedup state (a dropped duplicate adds no key, so
  // the kept rows' keys are the whole state), and the cursor says where the last page ended.
  const stored = await deps.datasets.storedRows(projectId, dataset.id);
  const counts = dataset.counts ?? {
    turns: plan.turns.length,
    calls: 0,
    cursor: null,
    train: 0,
    eval: 0,
    dropped: emptyDrops(),
  };
  builder.resume(stored, {
    dropped: counts.dropped,
    redaction: dataset.redactionReport ?? emptyCounts(),
  });
  const hashes = stored.map((row) => row.rowHash);
  const cursor = counts.cursor
    ? { capturedAt: new Date(counts.cursor.capturedAt), eventId: counts.cursor.eventId }
    : null;
  const remaining = cursor
    ? plan.calls.filter((call) => compareCalls(call, cursor) > 0)
    : plan.calls;
  let { train, eval: evalRows, calls: callsDone } = counts;
  const exportSkipped = { ...(counts.exportSkipped ?? { train: 0, eval: 0 }) };
  let last = counts.cursor;
  const cap = deps.rowCap ?? datasetRowCap();
  const pageSize = deps.pageCalls ?? PAGE_CALLS;
  const turnCache = new Map<string, CandidateTurn>();
  let pages = 0;

  for (let index = 0; index < remaining.length; index += pageSize) {
    const page = remaining.slice(index, index + pageSize);
    const rows = builder.add(await entriesOf(projectId, page, plan, turnCache, deps));
    for (const row of rows) {
      if (row.side === "train") train += 1;
      else evalRows += 1;
      if (!toChatExample(row.content).ok) exportSkipped[row.side] += 1;
      hashes.push(row.rowHash);
    }
    if (train + evalRows > cap) return fail(projectId, dataset, "too_large", deps);
    callsDone += page.length;
    const end = page[page.length - 1]!;
    last = { capturedAt: end.capturedAt.toISOString(), eventId: end.eventId };
    const progress = builder.counts();
    const appended = await deps.datasets.appendRows(projectId, dataset.id, rows, {
      counts: {
        turns: plan.turns.length,
        calls: callsDone,
        cursor: last,
        train,
        eval: evalRows,
        dropped: progress.dropped,
        exportSkipped,
      },
      redaction: progress.redaction,
    });
    if (!appended) return { built: false, datasetId, reason: "not_building" };
    pages += 1;
    const more = index + pageSize < remaining.length;
    const outOfTime =
      Date.now() - startedAt > RUN_DEADLINE_MS ||
      (deps.maxPagesPerRun !== undefined && pages >= deps.maxPagesPerRun);
    if (outOfTime && more) {
      await deps.enqueue(projectId, { datasetId });
      logger.info(
        {
          project_id: projectId,
          dataset_id: datasetId,
          calls_done: callsDone,
          calls: plan.calls.length,
          outcome: "continued",
        },
        "dataset build continued",
      );
      return { built: false, datasetId, reason: "continued" };
    }
  }

  if (train + evalRows === 0) return fail(projectId, dataset, "no_rows", deps);
  const contentHash = contentHashOf(hashes);
  const final = builder.counts();
  const ready = await deps.datasets.markReady(projectId, dataset.id, {
    contentHash,
    counts: {
      turns: plan.turns.length,
      calls: callsDone,
      cursor: last,
      train,
      eval: evalRows,
      dropped: final.dropped,
      exportSkipped,
    },
    redaction: final.redaction,
  });
  if (!ready) return { built: false, datasetId, reason: "not_building" };
  const built = (await deps.datasets.getDataset(projectId, dataset.id)) ?? dataset;
  await deps.recordSource(projectId, built, useCase);
  logger.info(
    {
      project_id: projectId,
      dataset_id: datasetId,
      rows: train + evalRows,
      train,
      eval: evalRows,
      outcome: "ready",
    },
    "dataset built",
  );
  await deps.track({ name: "dataset_built", projectId, dataset: built });
  return { built: true, datasetId, rows: train + evalRows, contentHash };
}

async function guardRefusal(
  projectId: string,
  deps: DatasetBuildDeps,
): Promise<DatasetFailure | null> {
  if (!(await deps.flagOn(projectId))) return "flag_off";
  if (!(await deps.consents.getActiveConsent(projectId))) return "no_consent";
  return null;
}

async function fail(
  projectId: string,
  dataset: Dataset,
  reason: DatasetFailure,
  deps: DatasetBuildDeps,
): Promise<RunResult> {
  const failed = await deps.datasets.markFailed(projectId, dataset.id, reason);
  logger.info(
    {
      project_id: projectId,
      dataset_id: dataset.id,
      reason,
      outcome: failed ? "failed" : "not_building",
    },
    "dataset build failed",
  );
  if (failed) await deps.track({ name: "dataset_build_failed", projectId, dataset, reason });
  return { built: false, datasetId: dataset.id, reason };
}

/** A call the first pass found: no content yet. */
interface PlannedCall {
  turnId: string;
  eventId: string;
  traceId: string | null;
  spanId: string | null;
  capturedAt: Date;
}

/** What the first pass reads once per run: every selected turn, its facts and group, and every call in build order. */
interface BuildPlan {
  turns: MatchedTurn[];
  turnsById: Map<string, MatchedTurn>;
  facts: Map<string, TurnFacts>;
  groups: Map<string, string>;
  evalCases: Set<string>;
  scorersByTask: Map<string, Scorer[]>;
  calls: PlannedCall[];
}

/**
 * The first pass. Deterministic, so a resumed run plans the same calls in the
 * same order: the turns in the frozen window, their split groups, and their
 * calls (after the call filter) sorted by capture time, then event id. A call
 * two turns both see is kept once, with the turn of the smaller id.
 */
async function planBuild(
  projectId: string,
  settings: Dataset["settings"],
  deps: DatasetBuildDeps,
): Promise<BuildPlan> {
  const turns = (
    await deps.calls.findClosedTurns(projectId, {
      taskIds: settings.selector.taskIds,
      intentIds: settings.selector.intentIds,
      since: new Date(settings.window.since),
      until: new Date(settings.window.until),
      limit: MAX_BUILD_TURNS,
    })
  ).sort((a, b) => (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0));
  const turnIds = turns.map((turn) => turn.turnId);
  const taskIds = [...new Set(turns.flatMap((turn) => (turn.taskId ? [turn.taskId] : [])))].sort();
  const [facts, evalCases, scorersByTask, traces] = await Promise.all([
    deps.facts.turnFacts(projectId, turnIds),
    deps.facts.evalCaseTurnIds(projectId, taskIds),
    deps.facts.taskScorers(projectId, taskIds),
    deps.calls.turnTraceIds(projectId, turnIds),
  ]);
  // The groups need every selected turn, so they come from this pass, not from a page.
  const groups = splitGroups(
    turns.map((turn) => ({
      turnId: turn.turnId,
      sessionId: facts.get(turn.turnId)?.sessionId ?? null,
      endUserKey: facts.get(turn.turnId)?.endUserKey ?? null,
    })),
  );
  const windows: TurnWindow[] = turns.map((turn) => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    traceIds: traces.get(turn.turnId) ?? [],
  }));
  const byTurn =
    windows.length > 0
      ? await deps.facts.modelCalls(projectId, windows)
      : new Map<string, ModelCall[]>();
  const spanNames = settings.selector.callFilter?.spanNames?.length
    ? await deps.calls.spanNames(
        projectId,
        [...byTurn.values()]
          .flat()
          .flatMap((call) =>
            call.traceId && call.spanId ? [{ traceId: call.traceId, spanId: call.spanId }] : [],
          ),
      )
    : new Map<string, string>();
  const seen = new Set<string>();
  const calls: PlannedCall[] = [];
  for (const turn of turns) {
    for (const call of byTurn.get(turn.turnId) ?? []) {
      if (!call.eventId || seen.has(call.eventId)) continue;
      const spanName =
        call.traceId && call.spanId
          ? (spanNames.get(`${call.traceId}:${call.spanId}`) ?? null)
          : null;
      if (!callMatches(settings.selector.callFilter, { model: call.model, spanName })) continue;
      seen.add(call.eventId);
      calls.push({
        turnId: turn.turnId,
        eventId: call.eventId,
        traceId: call.traceId ?? null,
        spanId: call.spanId ?? null,
        capturedAt: call.occurredAt,
      });
    }
  }
  calls.sort(compareCalls);
  return {
    turns,
    turnsById: new Map(turns.map((turn) => [turn.turnId, turn])),
    facts,
    groups,
    evalCases,
    scorersByTask,
    calls,
  };
}

/**
 * One page of calls as pipeline input, in build order: each call's content,
 * and its turn's facts and scores. A turn is read once per run (`cache`).
 */
async function entriesOf(
  projectId: string,
  page: readonly PlannedCall[],
  plan: BuildPlan,
  cache: Map<string, CandidateTurn>,
  deps: DatasetBuildDeps,
): Promise<CallEntry[]> {
  const missing = [...new Set(page.map((call) => call.turnId))].filter(
    (turnId) => !cache.has(turnId),
  );
  if (missing.length > 0) {
    const expectedTool = (turnId: string) => {
      const taskId = plan.turnsById.get(turnId)?.taskId;
      const scorer = taskId
        ? plan.scorersByTask.get(taskId)?.find((s) => s.kind === "expected_tool")
        : undefined;
      return scorer?.kind === "expected_tool" ? scorer.tool : null;
    };
    const [runs, userScores] = await Promise.all([
      deps.facts.scorerRuns(projectId, missing, expectedTool),
      deps.facts.userScores(projectId, missing),
    ]);
    for (const turnId of missing) {
      const fact = plan.facts.get(turnId);
      cache.set(turnId, {
        turnId,
        taskId: plan.turnsById.get(turnId)?.taskId ?? null,
        sessionId: fact?.sessionId ?? null,
        endUserKey: fact?.endUserKey ?? null,
        errorCount: fact?.errorCount ?? 0,
        selfCorrections: fact?.selfCorrections ?? 0,
        scorerRun: runs.get(turnId) ?? null,
        userScores: userScores.get(turnId) ?? [],
        calls: [],
      });
    }
  }
  const payloads = await deps.facts.callPayloads(
    projectId,
    page.map((call) => call.eventId),
  );
  return page.map(
    (call): CallEntry => ({
      turn: cache.get(call.turnId)!,
      call: {
        traceId: call.traceId ?? "",
        spanId: call.spanId ?? "",
        eventId: call.eventId,
        capturedAt: call.capturedAt,
        // A call with no trace or span cannot name its source: it is dropped as having no content.
        content: call.traceId && call.spanId ? (payloads.get(call.eventId) ?? null) : null,
      },
    }),
  );
}
