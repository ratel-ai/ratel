import { projectRoot } from "@/lib/console/navigation";
import type { DailyAggregateRow } from "@/lib/ingest/otlp/queries";
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
import type {
  TraceAggregateSummary,
  TraceDailyAggregate,
  TracesIngestDiagnostics,
} from "@/lib/synthesis/traces/queries";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import type { AlertingRule, AlertRuleCounts } from "@/lib/views/alerts/types";
import { pageGap } from "@/lib/views/health/data-gaps-model";
import { type IssueCategory, issueCategories } from "@/lib/views/health/issue-categories";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import { alertsWidget, type FocusedAlerts } from "@/lib/views/home/alerting";
import type { Attention } from "@/lib/views/home/attention";
import {
  type DashboardItems,
  type DashboardItemsRange,
  readDashboardItems,
} from "@/lib/views/home/dashboard-items";
import {
  type FixesSlice,
  type IntentsRead,
  intentsGlance,
  READ_FAILED,
  type TasksRead,
  tasksGlance,
} from "@/lib/views/home/glance";
import {
  firstTryTile,
  type OverviewData,
  type OverviewProject,
  overviewAttention,
  overviewDaily,
  overviewSdk,
} from "@/lib/views/home/load";
import { DATA_IS_MISSING } from "@/lib/views/home/no-score";
import {
  buildContextSplit,
  type ContextSplit,
  dailyCounts,
  type OverviewWindow,
  overviewRangeParam,
  previousWindow,
} from "@/lib/views/home/overview-model";
import {
  latestEventAt,
  newest,
  type OverviewReadScope,
  readAlerting,
  readAlertRuleCounts,
  readDailyAggregates,
  readDailyTraces,
  readFixes,
  readHealth,
  readIntentsGlance,
  readPendingRewrites,
  readPreviousTraces,
  readPromptCache,
  readSdkDays,
  readSdkLatestAt,
  readSdkPrevious,
  readTasksGlance,
  readTelemetry,
  readTraces,
  type SdkActivity,
  type SdkDay,
} from "@/lib/views/home/overview-reads";
import {
  type DashboardItemId,
  DEFAULT_LAYOUT,
  isDashboardItem,
  type OverviewLayout,
  visibleWidgets,
} from "@/lib/views/overview-layout/domain/layout";
import { readTopology, type Topology } from "@/lib/views/project-entities/topology";

/**
 * The recap Overview's reads (`focusedConsole`): when telemetry last arrived, and what the widgets
 * a person keeps need. A removed widget reads nothing. Each read degrades on its own, and one that
 * several widgets share runs once. The context Panel's read runs only when the Panel is asked for.
 */

export type LimitOrganization = Parameters<typeof getAgentHealthLimits>[0] &
  OverviewReadScope["organization"];

export type HealthCard =
  | {
      kind: "score";
      score: NonNullable<HealthPageModel["score"]>;
      early: boolean;
      /** Read below the usual floor (`toolRunInsights`): a first look, which claims no change. */
      lowConfidence: HealthPageModel["lowConfidence"] | null;
      /** The points each level of the score costs. */
      lost: readonly Pick<IssueCategory, "level" | "label" | "lost">[];
    }
  | {
      kind: "state";
      reason: NoScoreReason;
      line: string;
      /** How far the turns are, where more of them give a score. */
      progress: { turns: number; floor: number } | null;
    };

/** Why there is no score. More traces alone resolve only `no_turns` and `too_few`. */
export type NoScoreReason =
  | "failed"
  | "no_turns"
  | "too_few"
  | "first_reading"
  | "no_tool_calls"
  | "mixed_runs"
  | "no_score";

/** The project's traces against the window: none ever, only before it, or in it. */
export type TracesSeen = "none" | "before" | "in_window";

export interface FocusedHealth {
  href: string;
  /** The Agent health window, which the plan may cap below the Overview's. */
  windowDays: WindowDays;
  card: HealthCard;
}

/** What the stat row draws from (`focusedStats`). */
export type MetricsData = Pick<
  OverviewData,
  "root" | "window" | "rangeParam" | "previous" | "series" | "daily" | "sdk" | "health"
> & { traces: TraceAggregateSummary };

export interface FocusedAttention extends Attention {
  healthHref: string;
  /** Some of what it checks could not be read: an empty list is then not "nothing". */
  partial: boolean;
  /** What an empty list means. */
  state: AttentionState;
}

/**
 * `clear`: checked, and nothing needs a person. `not_enough`: too little data for Agent health to
 * look. `early`: there is enough, and Agent health has no whole reading yet.
 * `no_data`: nothing arrived in the window. `locked`: the plan hides the issues there are.
 */
export type AttentionState = "clear" | "not_enough" | "early" | "no_data" | "locked";

export interface FocusedOverviewContext {
  split: ContextSplit | null;
  suggestions: Suggestion[];
  promptCacheHitRate: number | null;
}

export type { FocusedAlerts };

/** A widget whose read failed. */
export type Failed = "failed";

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
  /** Null when it could not be read. */
  tracesSeen: TracesSeen | null;
  layout: OverviewLayout;
  /** Each widget is null when it is removed. */
  metrics: MetricsData | Failed | null;
  topology: Topology | Failed | null;
  health: FocusedHealth | null;
  attention: FocusedAttention | null;
  alerts: FocusedAlerts | Failed | null;
  /** The dashboard widgets on the Overview, by entry. Null when there is none. */
  dashboards: DashboardItems | Failed | null;
  /** Null unless the Panel is open and its read came back. */
  context: FocusedOverviewContext | null;
}

/** Each read, replaceable in tests. All of them may throw. */
export interface FocusedReads {
  telemetry: (at: OverviewReadScope) => Promise<TracesIngestDiagnostics>;
  sdkLatestAt: (at: OverviewReadScope) => Promise<Date | null>;
  traces: (at: OverviewReadScope) => Promise<TraceAggregateSummary>;
  previous: (at: OverviewReadScope) => Promise<TraceAggregateSummary>;
  dailyTraces: (at: OverviewReadScope) => Promise<TraceDailyAggregate[]>;
  sdkDays: (at: OverviewReadScope) => Promise<SdkDay[]>;
  sdkPrevious: (at: OverviewReadScope) => Promise<SdkActivity>;
  health: (
    at: OverviewReadScope,
    windowDays: WindowDays,
    limits: AgentHealthPlanLimits,
  ) => Promise<HealthPageModel>;
  topology: (at: OverviewReadScope) => Promise<Topology>;
  fixes: (at: OverviewReadScope) => Promise<FixesSlice>;
  pendingRewrites: (at: OverviewReadScope) => Promise<number>;
  intents: (at: OverviewReadScope) => Promise<IntentsRead | null>;
  tasks: (at: OverviewReadScope) => Promise<TasksRead | null>;
  dailyAggregates: (at: OverviewReadScope) => Promise<DailyAggregateRow[]>;
  alerting: (at: OverviewReadScope) => Promise<AlertingRule[]>;
  /** Read only when no rule alerts. */
  alertRules: (at: OverviewReadScope) => Promise<AlertRuleCounts>;
  dashboards: (
    at: OverviewReadScope,
    ids: readonly DashboardItemId[],
    range: DashboardItemsRange,
  ) => Promise<DashboardItems>;
  context: (at: OverviewReadScope, days: readonly string[]) => Promise<FocusedOverviewContext>;
}

/** A failed read, which is never the same as an empty one. */
const FAILED = Symbol("failed");
type Read<T> = T | typeof FAILED;

export async function loadFocusedOverview({
  project,
  organization,
  window,
  layout = DEFAULT_LAYOUT,
  contextOpen = false,
  now = new Date(),
  reads = FOCUSED_READS,
  limits = getAgentHealthLimits(organization),
  db,
}: {
  project: OverviewProject;
  organization: LimitOrganization;
  window: OverviewWindow;
  /** The person's layout: only its visible widgets are read. */
  layout?: OverviewLayout;
  /** The context Panel is open. */
  contextOpen?: boolean;
  now?: Date;
  reads?: FocusedReads;
  limits?: AgentHealthPlanLimits;
  /** Another database than the pool's, in tests. */
  db?: OverviewReadScope["db"];
}): Promise<FocusedOverviewData> {
  const { range } = resolveTraceListView({ range: overviewRangeParam(window) }, now);
  const rangeParam = overviewRangeParam(window);
  const windowDays = parseWindowDays(String(window), limits.agentHealthWindowDays);
  const scope: OverviewReadScope = {
    projectId: project.id,
    organization,
    current: { since: range.since, until: range.until },
    before: previousWindow(range, window, now),
    now,
    db,
  };
  const read = <K extends keyof FocusedReads, T>(
    name: K,
    load: (run: FocusedReads[K]) => Promise<T>,
  ): Promise<Read<T>> =>
    loadOrFallback<Read<T>>({
      operation: `overview_focused_${name}`,
      distinctId: `project:${project.id}`,
      fallback: FAILED,
      load: () => load(reads[name]),
    });
  const shared = {
    traces: once(() => read("traces", (run) => run(scope))),
    health: once(async () => {
      const model = await read("health", (run) => run(scope, windowDays, limits));
      return model === FAILED ? FAILED : applyPlanLimits(model, limits);
    }),
  };
  // The gauge is Agent health's reading; the numbers and Needs attention are the old Overview's.
  const usualHealth = once(async () => {
    const model = await shared.health();
    return model === FAILED ? FAILED : withoutLowConfidence(model);
  });
  const widgets = new Set(visibleWidgets(layout).map(({ id }) => id));
  const ifVisible = <T>(id: OverviewLayout[number]["id"], load: () => Promise<T>) =>
    widgets.has(id) ? load() : null;

  const items = [...widgets].filter(isDashboardItem);
  const { preset, from, to } = range;

  const [
    telemetry,
    sdkLatestAt,
    metrics,
    topology,
    health,
    attention,
    alerts,
    dashboards,
    context,
  ] = await Promise.all([
    read("telemetry", (run) => run(scope)),
    read("sdkLatestAt", (run) => run(scope)),
    ifVisible("metrics", metricsWidget),
    ifVisible("topology", () => read("topology", (run) => run(scope))),
    ifVisible("health", healthWidget),
    ifVisible("attention", attentionWidget),
    ifVisible("alerts", alertsData),
    items.length === 0
      ? null
      : read("dashboards", (run) =>
          run(scope, items, { preset: preset === "custom" ? rangeParam : preset, from, to }),
        ),
    contextOpen ? read("context", (run) => run(scope, range.days)) : null,
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
    tracesSeen: telemetry === FAILED ? null : tracesSeen(telemetry, range.since),
    layout,
    metrics,
    topology: topology === FAILED ? "failed" : topology,
    health,
    attention,
    alerts,
    dashboards: dashboards === FAILED ? "failed" : dashboards,
    context: context === FAILED ? null : context,
  };

  async function metricsWidget(): Promise<MetricsData | Failed> {
    const [traces, previous, dailyTraces, sdkDays, sdkPrevious] = await Promise.all([
      shared.traces(),
      read("previous", (run) => run(scope)),
      read("dailyTraces", (run) => run(scope)),
      read("sdkDays", (run) => run(scope)),
      read("sdkPrevious", (run) => run(scope)),
    ]);
    if (traces === FAILED) return "failed";
    const rows = {
      traces,
      dailyTraces: orNull(dailyTraces),
      sdkDays: orNull(sdkDays),
      sdkPrevious: orNull(sdkPrevious),
    };
    const sdk = overviewSdk(rows, range.days);
    // Only the numbers of a project without runs show the first try tile.
    const model = sdk && traces.count === 0 ? await usualHealth() : FAILED;
    return {
      root: projectRoot(project.id),
      window,
      rangeParam: overviewRangeParam(window),
      traces,
      previous: orNull(previous),
      series: dailyCounts(traces.volume, range.days),
      daily: overviewDaily(rows, range.days),
      sdk,
      health:
        model === FAILED
          ? null
          : {
              href: agentHealthHref(project.id, windowDays),
              windowDays,
              firstTry: firstTryTile(model),
            },
    };
  }

  async function healthWidget(): Promise<FocusedHealth> {
    return {
      href: agentHealthHref(project.id, windowDays),
      windowDays,
      card: healthCard(orNull(await shared.health())),
    };
  }

  async function alertsData(): Promise<FocusedAlerts | Failed> {
    const rules = await read("alerting", (run) => run(scope));
    if (rules === FAILED) return "failed";
    const counts = rules.length > 0 ? null : await read("alertRules", (run) => run(scope));
    return alertsWidget(project.id, rules, counts === FAILED ? null : counts, now);
  }

  async function attentionWidget(): Promise<FocusedAttention> {
    const fixesRead = read("fixes", (run) => run(scope));
    const [traces, health, fixes, pendingRewrites, intents, tasks, aggregates] = await Promise.all([
      shared.traces(),
      usualHealth(),
      fixesRead,
      // Fixes counts them, when it could be read.
      fixesRead.then((fixes) =>
        fixes === FAILED ? read("pendingRewrites", (run) => run(scope)) : 0,
      ),
      read("intents", (run) => run(scope)),
      read("tasks", (run) => run(scope)),
      read("dailyAggregates", (run) => run(scope)),
    ]);
    const dashboard = buildDashboardModel(aggregates === FAILED ? [] : aggregates, [...range.days]);
    const attention = overviewAttention({
      projectId: project.id,
      window,
      traces: orNull(traces),
      health: health === FAILED ? applyPlanLimits(pendingHealthModel(windowDays), limits) : health,
      healthWindow: windowDays,
      fixes: orNull(fixes),
      pendingRewrites: orNull(pendingRewrites),
      tasks: tasksGlance(project.id, tasks === FAILED ? READ_FAILED : tasks),
      unanswered: intentsGlance(project.id, intents === FAILED ? READ_FAILED : intents).unanswered,
      contextSuggestions: buildSuggestions(dashboard),
      contextSplit: buildContextSplit(dashboard),
    });
    return {
      ...attention,
      healthHref: agentHealthHref(project.id, windowDays),
      partial: [traces, health, pendingRewrites, intents, tasks, aggregates].includes(FAILED),
      state: attentionState(
        attention,
        health === FAILED ? null : health,
        (traces !== FAILED && traces.count > 0) || (aggregates !== FAILED && aggregates.length > 0),
      ),
    };
  }
}

/**
 * The reading by the usual floor, from one that may show a small project's numbers early
 * (`toolRunInsights`): the same issues, and not ready until its turns reach the floor. The low
 * floor changes nothing else that the Overview reads, so this costs no second read.
 */
export function withoutLowConfidence(model: HealthPageModel): HealthPageModel {
  if (!model.lowConfidence) return model;
  const { lowConfidence, ...usual } = model;
  return { ...usual, floor: lowConfidence.firmsUpAt };
}

/** The score as Agent health shows it, or in one line why there is none. Null: the read failed. */
export function healthCard(model: HealthPageModel | null): HealthCard {
  if (!model) return state("failed", "The Health score did not load.");
  const ready = healthReadiness(model) === "ready";
  if (ready && (model.computedAt === null || model.emptyEarlyReading))
    return state("first_reading", "Your first reading is being built.");
  if (ready) {
    const gap = pageGap(model);
    if (gap === "no_tool_calls")
      return state("no_tool_calls", "No score yet: no tool calls are recorded.");
    if (gap === "mixed_runs")
      return state("mixed_runs", "No score yet: runs are mixed together without turn ids.");
    if (!model.score) return state("no_score", "This reading has no score.");
    return {
      kind: "score",
      score: model.score,
      early: !!model.earlyReading,
      lowConfidence: model.lowConfidence ?? null,
      lost: issueCategories([], model.score).map(({ level, label, lost }) => ({
        level,
        label,
        lost,
      })),
    };
  }
  if (model.turns > 0)
    return state("too_few", `Too few turns: ${model.turns} of the ${model.floor} a score needs.`, {
      turns: model.turns,
      floor: model.floor,
    });
  if (model.waitingOn === "tool_spans")
    return state("no_tool_calls", "Collecting: no tool calls have arrived yet.");
  return state("no_turns", "Collecting: no turns in this window yet.", {
    turns: 0,
    floor: model.floor,
  });
}

/** By the newest span: no read of its own. */
export function tracesSeen(
  { hasSpans, latestSpanAt }: Pick<TracesIngestDiagnostics, "hasSpans" | "latestSpanAt">,
  since: Date,
): TracesSeen {
  if (!hasSpans || latestSpanAt === null) return "none";
  return latestSpanAt < since ? "before" : "in_window";
}

/** The pool's reads. */
export const FOCUSED_READS: FocusedReads = {
  telemetry: readTelemetry,
  sdkLatestAt: readSdkLatestAt,
  traces: readTraces,
  previous: readPreviousTraces,
  dailyTraces: readDailyTraces,
  sdkDays: readSdkDays,
  sdkPrevious: readSdkPrevious,
  // The same reading as Agent health's.
  health: async (at, windowDays, limits) =>
    readHealth(
      at,
      windowDays,
      limits,
      (await toolRunInsightsEnabled(at.projectId, at.organization))
        ? LOW_CONFIDENCE_FLOOR
        : undefined,
    ),
  topology: (at) =>
    withStatementTimeout(
      (db) => readTopology(at.projectId, at.current, { agents: createDrizzleAgentStore(db), db }),
      {
        operation: "overview_focused_topology",
        timeoutMs: supplementaryReadTimeoutMs(),
        db: at.db,
      },
    ),
  fixes: readFixes,
  pendingRewrites: readPendingRewrites,
  intents: readIntentsGlance,
  tasks: readTasksGlance,
  dailyAggregates: readDailyAggregates,
  alerting: readAlerting,
  alertRules: readAlertRuleCounts,
  dashboards: readDashboardItems,
  context: async (at, days) => {
    const [daily, cache] = await Promise.all([readDailyAggregates(at), readPromptCache(at)]);
    const dashboard = buildDashboardModel(daily, [...days]);
    return {
      split: buildContextSplit(dashboard),
      suggestions: buildSuggestions(dashboard),
      promptCacheHitRate: promptCacheHitRate(cache),
    };
  },
};

// — Helpers ——————————————————————————————————————————————————————————————————

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    running ??= load();
    return running;
  };
}

function attentionState(
  { items, moreIssues }: Attention,
  health: HealthPageModel | null,
  arrived: boolean,
): AttentionState {
  if (items.length === 0 && moreIssues > 0) return "locked";
  if (!arrived && (health?.turns ?? 0) === 0) return "no_data";
  const card = healthCard(health);
  if (card.kind === "score" || card.reason === "no_score") return "clear";
  return DATA_IS_MISSING.has(card.reason) ? "not_enough" : "early";
}

function orNull<T>(value: Read<T>): T | null {
  return value === FAILED ? null : value;
}

function state(
  reason: NoScoreReason,
  line: string,
  progress: Extract<HealthCard, { kind: "state" }>["progress"] = null,
): HealthCard {
  return { kind: "state", reason, line, progress };
}
