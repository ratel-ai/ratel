import { projectRoot } from "@/lib/console/navigation";
import { getDailyAggregates, getPromptCacheTotals } from "@/lib/ingest/otlp/queries";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { toolRunInsightsEnabled } from "@/lib/readings/trace-signals/tool-run-insights";
import {
  type AgentHealthPlanLimits,
  agentHealthHref,
  applyPlanLimits,
  type HealthPageModel,
  healthReadiness,
  LOW_CONFIDENCE_FLOOR,
  parseWindowDays,
  type WindowDays,
} from "@/lib/readings/trace-signals/view";
import {
  buildDashboardModel,
  buildSuggestions,
  promptCacheHitRate,
  type Suggestion,
} from "@/lib/synthesis/dashboard";
import {
  getTracesIngestDiagnostics,
  type TracesIngestDiagnostics,
} from "@/lib/synthesis/traces/queries";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import { pageGap } from "@/lib/views/health/data-gaps-model";
import { type IssueCategory, issueCategories } from "@/lib/views/health/issue-categories";
import { loadHealthPageModel } from "@/lib/views/health/page-model";
import {
  latestEventAt,
  latestSdkEventAt,
  newest,
  type OverviewProject,
} from "@/lib/views/home/load";
import {
  buildContextSplit,
  type ContextSplit,
  type OverviewWindow,
  overviewRangeParam,
} from "@/lib/views/home/overview-model";
import { readTopology, type Topology } from "@/lib/views/project-entities/topology";

/**
 * The recap Overview's reads (`focusedConsole`): when telemetry last arrived,
 * the Agent health reading and the topology, nothing else. Each degrades on
 * its own. The context Panel's read runs only when the Panel is asked for.
 */

type LimitOrganization = Parameters<typeof getAgentHealthLimits>[0] & { id: string };

export type HealthCard =
  | {
      kind: "score";
      score: NonNullable<HealthPageModel["score"]>;
      early: boolean;
      /** The points each level of the score costs. */
      lost: readonly Pick<IssueCategory, "level" | "label" | "lost">[];
    }
  | { kind: "state"; line: string; failed: boolean };

export interface FocusedHealth {
  href: string;
  /** The Agent health window, which the plan may cap below the Overview's. */
  windowDays: WindowDays;
  card: HealthCard;
}

export interface FocusedOverviewContext {
  split: ContextSplit | null;
  suggestions: Suggestion[];
  promptCacheHitRate: number | null;
}

export interface FocusedOverviewData {
  project: OverviewProject;
  root: string;
  window: OverviewWindow;
  rangeParam: `${OverviewWindow}d`;
  lastEventAt: Date | null;
  /** Whether both telemetry reads came back: without them, "no data yet" is not known. */
  telemetryRead: boolean;
  /** False only when nothing has ever arrived: the page is the setup guide. */
  hasTelemetry: boolean;
  health: FocusedHealth;
  /** Null when it could not be read. */
  topology: Topology | null;
  /** Null unless the Panel is open and its read came back. */
  context: FocusedOverviewContext | null;
}

/** Each read, replaceable in tests. All of them may throw. */
export interface FocusedReads {
  telemetry: (projectId: string) => Promise<TracesIngestDiagnostics>;
  sdkLatestAt: (projectId: string) => Promise<Date | null>;
  health: (
    projectId: string,
    windowDays: WindowDays,
    organization: LimitOrganization,
    limits: AgentHealthPlanLimits,
  ) => Promise<HealthPageModel>;
  topology: (projectId: string, window: { since: Date; until: Date }) => Promise<Topology>;
  context: (
    projectId: string,
    range: { since: Date; until: Date; days: readonly string[] },
  ) => Promise<FocusedOverviewContext>;
}

/** A failed read, which is never the same as an empty one. */
const FAILED = Symbol("failed");

export async function loadFocusedOverview({
  project,
  organization,
  window,
  contextOpen = false,
  now = new Date(),
  reads = READS,
  limits = getAgentHealthLimits(organization),
}: {
  project: OverviewProject;
  organization: LimitOrganization;
  window: OverviewWindow;
  /** The context Panel is open. */
  contextOpen?: boolean;
  now?: Date;
  reads?: FocusedReads;
  limits?: AgentHealthPlanLimits;
}): Promise<FocusedOverviewData> {
  const { range } = resolveTraceListView({ range: overviewRangeParam(window) }, now);
  const windowDays = parseWindowDays(String(window), limits.agentHealthWindowDays);
  const degrade = <T>(operation: string, load: () => Promise<T>) =>
    loadOrFallback<T | typeof FAILED>({
      operation: `overview_focused_${operation}`,
      distinctId: `project:${project.id}`,
      fallback: FAILED,
      load,
    });
  const [telemetry, sdkLatestAt, health, topology, context] = await Promise.all([
    degrade("telemetry", () => reads.telemetry(project.id)),
    degrade("sdk_latest", () => reads.sdkLatestAt(project.id)),
    degrade("agent_health", () => reads.health(project.id, windowDays, organization, limits)),
    degrade("topology", () => reads.topology(project.id, range)),
    contextOpen ? degrade("context", () => reads.context(project.id, range)) : null,
  ]);
  const lastEventAt = newest(
    telemetry === FAILED ? null : latestEventAt(telemetry),
    sdkLatestAt === FAILED ? null : sdkLatestAt,
  );
  const telemetryRead = telemetry !== FAILED && sdkLatestAt !== FAILED;
  return {
    project,
    root: projectRoot(project.id),
    window,
    rangeParam: overviewRangeParam(window),
    lastEventAt,
    telemetryRead,
    hasTelemetry: !telemetryRead || lastEventAt !== null,
    health: {
      href: agentHealthHref(project.id, windowDays),
      windowDays,
      card: healthCard(health === FAILED ? null : applyPlanLimits(health, limits)),
    },
    topology: topology === FAILED ? null : topology,
    context: context === FAILED ? null : context,
  };
}

/** The score as Agent health shows it, or in one line why there is none. Null: the read failed. */
export function healthCard(model: HealthPageModel | null): HealthCard {
  if (!model) return state("The Health score did not load.", true);
  const ready = healthReadiness(model) === "ready";
  if (ready && (model.computedAt === null || model.emptyEarlyReading))
    return state("Your first reading is being built.");
  if (ready) {
    const gap = pageGap(model);
    if (gap === "no_tool_calls") return state("No score yet: no tool calls are recorded.");
    if (gap === "mixed_runs")
      return state("No score yet: runs are mixed together without turn ids.");
    if (!model.score) return state("This reading has no score.");
    return {
      kind: "score",
      score: model.score,
      early: !!model.earlyReading,
      lost: issueCategories([], model.score).map(({ level, label, lost }) => ({
        level,
        label,
        lost,
      })),
    };
  }
  if (model.turns > 0)
    return state(`Too few turns: ${model.turns} of the ${model.floor} a score needs.`);
  if (model.waitingOn === "tool_spans") return state("Collecting: no tool calls have arrived yet.");
  return state("Collecting: no turns in this window yet.");
}

// — Helpers ——————————————————————————————————————————————————————————————————

const READS: FocusedReads = {
  telemetry: (projectId) =>
    bounded("overview_focused_telemetry", (db) => getTracesIngestDiagnostics(projectId, db)),
  sdkLatestAt: (projectId) =>
    bounded("overview_focused_sdk_latest", (db) => latestSdkEventAt(projectId, db)),
  health: async (projectId, windowDays, organization, limits) =>
    // The same reading as Agent health's, without example turns.
    loadHealthPageModel(
      {
        projectId,
        windowDays,
        lowConfidenceFloor: (await toolRunInsightsEnabled(projectId, organization))
          ? LOW_CONFIDENCE_FLOOR
          : undefined,
      },
      process.env.NODE_ENV,
      { getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }) },
    ),
  topology: (projectId, { since, until }) =>
    bounded("overview_focused_topology", (db) =>
      readTopology(projectId, { since, until }, { agents: createDrizzleAgentStore(db), db }),
    ),
  context: async (projectId, { since, until, days }) => {
    const [daily, cache] = await Promise.all([
      getDailyAggregates(projectId, since, until),
      bounded("overview_focused_prompt_cache", (db) =>
        getPromptCacheTotals(projectId, since, until, db),
      ),
    ]);
    const dashboard = buildDashboardModel(daily, [...days]);
    return {
      split: buildContextSplit(dashboard),
      suggestions: buildSuggestions(dashboard),
      promptCacheHitRate: promptCacheHitRate(cache),
    };
  },
};

function bounded<T>(
  operation: string,
  read: Parameters<typeof withStatementTimeout<T>>[0],
): Promise<T> {
  return withStatementTimeout(read, { operation, timeoutMs: supplementaryReadTimeoutMs() });
}

function state(line: string, failed = false): HealthCard {
  return { kind: "state", line, failed };
}
