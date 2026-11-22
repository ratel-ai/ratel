import { countClosedTurns, hasLedger, hasModelCallsSince } from "@/lib/ledger/closed-turns";
import { getDb } from "@/lib/platform/db/client";
import { type AgentHealthLimits, getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  DISMISSABLE_KINDS,
  type DismissableKind,
  type DismissedSignal,
  isDismissable,
} from "@/lib/readings/trace-signals/dismiss";
import { SCORE_TREND_READINGS } from "@/lib/readings/trace-signals/health-score";
import {
  loadCatalogNames,
  loadSucceededTools,
} from "@/lib/readings/trace-signals/signals/analysis-context";
import { targetWindowDays } from "@/lib/readings/trace-signals/signals/compute";
import {
  type EarlyProgress,
  earlyProgress,
} from "@/lib/readings/trace-signals/signals/early-reading";
import {
  latestSignalRun,
  listEarlierHealthScores,
  listMutedSignals,
  listOpenSignals,
} from "@/lib/readings/trace-signals/signals/queries";
import {
  catalogIdentities,
  unknownToolsToProbe,
  withToolStandings,
} from "@/lib/readings/trace-signals/signals/unknown-tool-standing";
import type { HealthPageModel, SignalKind, WindowDays } from "@/lib/readings/trace-signals/view";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import { loadWorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide-queries";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import { type EvidenceDb, loadEvidenceTurns } from "@/lib/views/health/evidence";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import {
  buildHealthPageModel,
  type CompletedRun,
  mixOf,
  parseRunSummary,
  toSignalRecord,
} from "@/lib/views/health/signals/page-view";

const logger = getLogger("trace-signals.page-model");

/**
 * Where the Agent health page gets its model: the latest completed signal run
 * (its summary carries the band, shapes and flow), the open signals, and their
 * evidence stories, cut to the plan's evidence allowance before any turn is
 * read.
 *
 * Readiness follows from `turns` (see `healthReadiness`): 0 closed turns in the
 * window is "no telemetry", fewer than `FIRST_READING_FLOOR` is "collecting",
 * anything else is "ready". Before the first run the turn count is read live.
 *
 * The development fixture renders ONLY under `NODE_ENV=development` for a
 * project with no ledger at all, so local dev without data still shows the demo.
 * Production, staging and tests never render it.
 */

const DAY_MS = 86_400_000;

export function shouldUseHealthFixture(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  projectHasLedger = false,
): boolean {
  return nodeEnv === "development" && !projectHasLedger;
}

/** The model a page renders when nothing can be read: the empty state on its window. */
export function pendingHealthModel(windowDays: WindowDays): HealthPageModel {
  return buildHealthPageModel({
    windowDays,
    run: null,
    liveTurns: 0,
    signals: [],
    evidence: new Map(),
    names: new Map(),
  });
}

export interface PageModelDeps {
  db: EvidenceDb & Pick<ReturnType<typeof getDb>, "select">;
  getLimits: (projectId: string) => Promise<AgentHealthLimits>;
  now: () => Date;
  /** Model-written workflow names; the page falls back to tool-order names without them. */
  getLabels: (projectId: string) => Promise<WorkflowLabels>;
  getInsights: (projectId: string) => Promise<WorkflowInsights | null>;
}

/** A project without an organization (unreachable through the schema) reads nothing. */
const NO_ORGANIZATION_LIMITS: AgentHealthLimits = {
  agentHealthSignalsShown: 0,
  agentHealthEvidenceTurns: 0,
  agentHealthWindowDays: 30,
};

/**
 * The workflow names, never failing the page: a missing table or a bad read
 * logs and falls back to names made from the tools.
 */
export async function workflowLabelsFor(
  projectId: string,
  db: PageModelDeps["db"] = getDb(),
): Promise<WorkflowLabels> {
  try {
    return await loadWorkflowLabels(projectId, db);
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "workflow labels unreadable for agent health page",
    );
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "agent_health_load_workflow_labels",
    });
    return new Map();
  }
}

/** The choice model's read of captured asks, never failing the page. */
async function insightsFor(
  projectId: string,
  db: PageModelDeps["db"],
): Promise<WorkflowInsights | null> {
  try {
    return (await loadWorkflowInsights(projectId, db))?.data ?? null;
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "workflow insights unreadable for agent health page",
    );
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "agent_health_load_workflow_insights",
    });
    return null;
  }
}

/**
 * How far an early reading has got: the turns it read of the closed turns in
 * the plan's whole window now. Supplementary: a failed count shows no
 * percentage, never a wrong one.
 */
async function earlyProgressFor(
  projectId: string,
  read: number,
  planDays: number,
  now: Date,
  db: PageModelDeps["db"],
): Promise<EarlyProgress | null> {
  try {
    const total = await countClosedTurns(
      projectId,
      new Date(now.getTime() - targetWindowDays(planDays) * DAY_MS),
      now,
      db,
    );
    return earlyProgress(read, total);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "early reading progress unreadable");
    reportServerException(err, `project:${projectId}`, {
      operation: "agent_health_early_progress",
    });
    return null;
  }
}

/**
 * The signals as this reading tells them: an `unknown_tool`
 * about a tool that exists says so. Never failing the page: a bad read logs and
 * tells them as stored. Asked only of a project with such a signal.
 */
async function withUnknownToolStandings(
  projectId: string,
  records: SignalRecord[],
  names: ReadonlyMap<string, string>,
  window: { windowStart: Date; windowEnd: Date },
  deps: PageModelDeps,
): Promise<SignalRecord[]> {
  if (!records.some((record) => record.kind === "unknown_tool")) return records;
  try {
    const succeededToolIds = await loadSucceededTools(
      projectId,
      unknownToolsToProbe(records),
      window,
      deps.db,
    );
    return withToolStandings(records, { catalog: catalogIdentities(names), succeededToolIds });
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "unknown tool standing unreadable for agent health page",
    );
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "agent_health_unknown_tool_standing",
    });
    return records;
  }
}

async function limitsFor(projectId: string): Promise<AgentHealthLimits> {
  const organization = await getOrganizationByProjectId(projectId);
  return organization ? getAgentHealthLimits(organization) : NO_ORGANIZATION_LIMITS;
}

export async function loadHealthPageModel(
  {
    projectId,
    windowDays,
    lowConfidenceFloor,
  }: { projectId: string; windowDays: WindowDays; lowConfidenceFloor?: number },
  nodeEnv: string | undefined = process.env.NODE_ENV,
  overrides: Partial<PageModelDeps> = {},
): Promise<HealthPageModel> {
  const db = overrides.db ?? getDb();
  const deps: PageModelDeps = {
    db,
    getLimits: limitsFor,
    now: () => new Date(),
    getLabels: (id) => workflowLabelsFor(id, db),
    getInsights: (id) => insightsFor(id, db),
    ...overrides,
  };
  const now = deps.now();
  const run = await latestSignalRun(projectId, deps.db, "completed");
  const summary = run ? parseRunSummary(run.summary) : null;
  if (!run || !summary) {
    const liveTurns = await countClosedTurns(
      projectId,
      new Date(now.getTime() - windowDays * DAY_MS),
      now,
      deps.db,
    );
    const since = new Date(now.getTime() - windowDays * DAY_MS);
    // Model calls without tool spans never make a run: say so instead of waiting forever.
    if (liveTurns === 0 && (await hasModelCallsSince(projectId, since, deps.db))) {
      const pending = buildHealthPageModel(
        { windowDays, run: null, liveTurns, signals: [], evidence: new Map(), names: new Map() },
        now,
      );
      return { ...pending, waitingOn: "tool_spans" };
    }
    if (
      liveTurns === 0 &&
      nodeEnv === "development" &&
      shouldUseHealthFixture(nodeEnv, await hasLedger(projectId, deps.db))
    ) {
      return { ...MOCK_HEALTH_MODEL, windowDays };
    }
    return buildHealthPageModel(
      { windowDays, run: null, liveTurns, signals: [], evidence: new Map(), names: new Map() },
      now,
    );
  }

  const [limits, rows, names, labels, insights, muted, scoreHistory] = await Promise.all([
    deps.getLimits(projectId),
    listOpenSignals(projectId, deps.db),
    loadCatalogNames(projectId, deps.db),
    deps.getLabels(projectId),
    deps.getInsights(projectId),
    listMutedSignals(projectId, DISMISSABLE_KINDS, deps.db),
    listEarlierHealthScores(projectId, SCORE_TREND_READINGS - 1, deps.db),
  ]);
  const records = await withUnknownToolStandings(
    projectId,
    rows.map(toSignalRecord).filter((r): r is SignalRecord => r !== null),
    names,
    run,
    deps,
  );
  const shown = Number.isFinite(limits.agentHealthSignalsShown)
    ? records.slice(0, Math.max(0, Math.floor(limits.agentHealthSignalsShown)))
    : records;
  const evidence = await loadEvidenceTurns(
    projectId,
    shown.map((r) => ({
      signalId: r.id,
      kind: r.kind,
      subjectIds: r.subjectIds,
      turnIds: r.turnIds,
    })),
    limits.agentHealthEvidenceTurns,
    names,
    deps.db,
  );
  const completed: CompletedRun = {
    windowEnd: run.windowEnd,
    windowDays: run.windowDays,
    finishedAt: run.finishedAt,
    summary,
    turnSourceMix: mixOf(run.turnSourceMix),
    turnsScanned: run.turnsScanned,
  };
  const model = buildHealthPageModel(
    {
      windowDays,
      run: completed,
      liveTurns: 0,
      signals: records,
      evidence,
      names,
      labels,
      insights,
      scoreHistory,
      ...(lowConfidenceFloor !== undefined ? { lowConfidenceFloor } : {}),
    },
    now,
  );
  const progress = model.earlyReading
    ? await earlyProgressFor(
        projectId,
        run.turnsScanned,
        limits.agentHealthWindowDays,
        now,
        deps.db,
      )
    : null;
  return {
    ...model,
    dismissed: dismissedOf(muted, names),
    ...(progress ? { earlyProgress: progress } : {}),
  };
}

/** Hidden slow-tool signals, named for the "Show again" line. */
function dismissedOf(
  rows: readonly { id: string; kind: string; subjectKey: string }[],
  names: ReadonlyMap<string, string>,
): DismissedSignal[] {
  return rows.flatMap((row): DismissedSignal[] =>
    isDismissable(row.kind as SignalKind)
      ? [
          {
            id: row.id,
            kind: row.kind as DismissableKind,
            toolId: row.subjectKey,
            label: names.get(row.subjectKey) ?? row.subjectKey,
          },
        ]
      : [],
  );
}
