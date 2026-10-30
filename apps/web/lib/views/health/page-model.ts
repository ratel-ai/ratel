import { countClosedTurns, hasLedger, hasModelCallsSince } from "@/lib/ledger/closed-turns";
import { getDb } from "@/lib/platform/db/client";
import { type AgentHealthLimits, getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  DISMISSABLE_KINDS,
  type DismissableKind,
  type DismissedSignal,
  isDismissable,
} from "@/lib/readings/trace-signals/dismiss";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import {
  latestSignalRun,
  listMutedSignals,
  listOpenSignals,
} from "@/lib/readings/trace-signals/signals/queries";
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

async function limitsFor(projectId: string): Promise<AgentHealthLimits> {
  const organization = await getOrganizationByProjectId(projectId);
  return organization ? getAgentHealthLimits(organization) : NO_ORGANIZATION_LIMITS;
}

export async function loadHealthPageModel(
  { projectId, windowDays }: { projectId: string; windowDays: WindowDays },
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

  const [limits, rows, names, labels, insights, muted] = await Promise.all([
    deps.getLimits(projectId),
    listOpenSignals(projectId, deps.db),
    loadCatalogNames(projectId, deps.db),
    deps.getLabels(projectId),
    deps.getInsights(projectId),
    listMutedSignals(projectId, DISMISSABLE_KINDS, deps.db),
  ]);
  const records = rows.map(toSignalRecord).filter((r): r is SignalRecord => r !== null);
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
    },
    now,
  );
  return { ...model, dismissed: dismissedOf(muted, names) };
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
