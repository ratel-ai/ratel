import { projectRoot } from "@/lib/console/navigation";
import type { DailyAggregateRow, PromptCacheTotals } from "@/lib/ingest/otlp/queries";
import type { getDb } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  type AgentHealthPlanLimits,
  agentHealthHref,
  applyPlanLimits,
  type HealthPageModel,
  type HealthTile,
  healthReadiness,
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
  TraceSummary,
  TracesIngestDiagnostics,
} from "@/lib/synthesis/traces/queries";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";
import { fixHref } from "@/lib/views/fixes/href";
import type { loadFixes } from "@/lib/views/fixes/load";
import type { Fix } from "@/lib/views/fixes/types";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import {
  loadSelfCorrectionsCard,
  type SelfCorrectionsCardModel,
  unavailableSelfCorrectionsCard,
} from "@/lib/views/health/self-corrections/card";
import { type Attention, buildAttention } from "@/lib/views/home/attention";
import { CONTEXT_PEEK } from "@/lib/views/home/context-peek";
import {
  applicableDescriptions,
  descriptionsHref,
  type FixesSlice,
  fixesGlance,
  type Glance,
  type GlanceRead,
  type IntentsRead,
  intentsGlance,
  READ_FAILED,
  selfCorrectionsGlance,
  type TaskRef,
  type TasksGlance,
  type TasksRead,
  tasksGlance,
  type UnansweredIntent,
} from "@/lib/views/home/glance";
import {
  buildContextSplit,
  type ContextSplit,
  dailyCounts,
  dailyFailureShares,
  dailyReadings,
  type OverviewWindow,
  overviewRangeParam,
  previousWindow,
} from "@/lib/views/home/overview-model";
import {
  latestEventAt,
  newest,
  type OverviewReadScope,
  readDailyAggregates,
  readDailyTraces,
  readFixes,
  readHealth,
  readIntentsGlance,
  readPendingRewrites,
  readPreviousTraces,
  readPromptCache,
  readRecentRuns,
  readSdkDays,
  readSdkLatestAt,
  readSdkPrevious,
  readTasksGlance,
  readTasksOfRuns,
  readTelemetry,
  readTraces,
  type SdkActivity,
  type SdkDay,
} from "@/lib/views/home/overview-reads";

export { CONTEXT_PEEK } from "@/lib/views/home/context-peek";
export type { FixesSlice } from "@/lib/views/home/glance";
export {
  countPendingRewrites,
  countSdkActivity,
  countSdkActivityByDay,
  latestEventAt,
  latestSdkEventAt,
  newest,
  type SdkActivity,
  type SdkDay,
} from "@/lib/views/home/overview-reads";

type FixesOrganization = Parameters<typeof loadFixes>[0]["organization"];
type LimitOrganization = Parameters<typeof getAgentHealthLimits>[0];

export interface OverviewProject {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
}

export interface OverviewHealth {
  href: string;
  /** The Agent health window, which the plan may cap below the Overview's. */
  windowDays: WindowDays;
  /** The first try tile once there is a reading; null while collecting. */
  firstTry: HealthTile | null;
}

/** The readings under the stats, one per day of the window; null on a day without one. */
export interface OverviewDaily {
  /** Each day's failed share of its runs. */
  failedShare: (number | null)[];
  /** Each day's average run duration, in ms. */
  duration: (number | null)[];
  /** Each day's spend. */
  spend: (number | null)[];
}

export interface OverviewData {
  project: OverviewProject;
  root: string;
  window: OverviewWindow;
  rangeParam: `${OverviewWindow}d`;
  lastEventAt: Date | null;
  /** False only when nothing has ever arrived: the page is the setup guide. */
  hasTelemetry: boolean;
  /** Null when the window's numbers could not be read. */
  traces: TraceAggregateSummary | null;
  /** Null without a comparison: no change figures. */
  previous: TraceAggregateSummary | null;
  /** Runs per day across the window, oldest first. */
  series: number[];
  /** The other stats' days; every day null when they could not be read. */
  daily: OverviewDaily;
  /** Null when the list could not be read. */
  recentRuns: TraceSummary[] | null;
  /** The task each recent run was placed in, by trace id, when one is known. */
  runTasks: Readonly<Record<string, TaskRef>>;
  /** Null when Agent health is off for this project. */
  health: OverviewHealth | null;
  /**
   * SDK events in the window (with each day's) and the window before. A
   * project can send these without any traces; then they are its only sign
   * of life on this page.
   */
  sdk: { current: SdkActivity; previous: SdkActivity | null; days: SdkActivity[] } | null;
  attention: Attention;
  /** Intents, tasks, self-corrections and fixes, one tile each. */
  glance: Glance;
  context: ContextSplit | null;
  contextSuggestions: Suggestion[];
  /** Share of input tokens served from the prompt cache; null with the flag off, no input or a failed read. */
  promptCacheHitRate?: number | null;
}

/** Everything the page reads, with each degradable read already null (or failed) on failure. */
export interface OverviewReads {
  traces: TraceAggregateSummary | null;
  previous: TraceAggregateSummary | null;
  /** The window's runs day by day, for the sparks; null when the read failed. */
  dailyTraces: TraceDailyAggregate[] | null;
  recentRuns: TraceSummary[] | null;
  /** Each recent run's task id, by trace id; empty when none is known or the read failed. */
  runTasks: ReadonlyMap<string, string>;
  /** Null when the read failed: then nobody is sent to the setup guide by mistake. */
  telemetry: TracesIngestDiagnostics | null;
  dailyAggregates: DailyAggregateRow[];
  /** The window's cached and input tokens for the prompt cache hit rate. Absent or null when unread. */
  promptCache?: PromptCacheTotals | null;
  /** Null when Agent health is off. */
  health: HealthPageModel | null;
  healthLimits: AgentHealthPlanLimits;
  healthWindow: WindowDays;
  /** Null when Quality is off. */
  pendingRewrites: number | null;
  /** Null when the read failed: issues then open Agent health, and rewrites use the count above. */
  fixes: FixesSlice | null;
  /** SDK activity day by day; null when the read failed. */
  sdkDays: SdkDay[] | null;
  sdkPrevious: SdkActivity | null;
  /** The newest SDK event ever, for "Last event"; null with none or on failure. */
  sdkLatestAt: Date | null;
  /** The latest intents reading; null before the first, `failed` when unread. */
  intents: GlanceRead<IntentsRead>;
  /** The latest tasks reading; null before the first, `failed` when unread. */
  tasks: GlanceRead<TasksRead>;
  /** Agent health's self-corrections card (its own fallback says when it failed). */
  corrections: SelfCorrectionsCardModel;
}

/**
 * Overview v2's reads, in one round. Every read runs under a statement
 * timeout and degrades on its own (logged and reported by `loadOrFallback`),
 * so one slow aggregate on a dense project costs a number or a tile, never
 * the page.
 *
 * Owned (ADR-0004): no feature-flag gate, since Agent health is always on
 * here; its read runs with the rest.
 */
export async function loadOverview({
  project,
  organization,
  window,
  now = new Date(),
  db,
}: {
  project: OverviewProject;
  organization: FixesOrganization & LimitOrganization;
  window: OverviewWindow;
  now?: Date;
  /** Another database than the pool's, in tests. */
  db?: ReturnType<typeof getDb>;
}): Promise<OverviewData> {
  const { range } = resolveTraceListView({ range: overviewRangeParam(window) }, now);
  const distinctId = `project:${project.id}`;
  const healthLimits = getAgentHealthLimits(organization);
  const healthWindow = parseWindowDays(String(window), healthLimits.agentHealthWindowDays);
  const scope: OverviewReadScope = {
    projectId: project.id,
    organization,
    current: { since: range.since, until: range.until },
    before: previousWindow(range, window, now),
    now,
    db,
  };
  const or = <T, F = T>(
    operation: string,
    fallback: F,
    read: (scope: OverviewReadScope) => Promise<T>,
  ): Promise<T | F> =>
    loadOrFallback<T | F>({ operation, distinctId, fallback, load: () => read(scope) });

  const recentRuns = or("overview_recent_runs", null, readRecentRuns);
  // Starts as soon as the runs are in, alongside the rest of the round.
  const runTasks = recentRuns.then((runs) =>
    runs && runs.length > 0
      ? or<ReadonlyMap<string, string>>("overview_run_tasks", new Map(), (at) =>
          readTasksOfRuns(at, runs),
        )
      : new Map<string, string>(),
  );

  // One round: the pool queues what it cannot run at once, the page's own numbers first.
  const [
    traces,
    recent,
    recentTasks,
    telemetry,
    health,
    fixes,
    previous,
    dailyTraces,
    dailyAggregates,
    pendingRewrites,
    sdkDays,
    sdkPrevious,
    sdkLatestAt,
    intents,
    tasks,
    corrections,
    promptCache,
  ] = await Promise.all([
    or("overview_trace_aggregate", null, readTraces),
    recentRuns,
    runTasks,
    or("overview_telemetry", null, readTelemetry),
    or("overview_agent_health", pendingHealthModel(healthWindow), (at) =>
      readHealth(at, healthWindow, healthLimits),
    ),
    // Each of its sources degrades on its own; this fallback covers the rest.
    or("overview_fixes", null, readFixes),
    or("overview_previous_aggregate", null, readPreviousTraces),
    or("overview_trace_daily", null, readDailyTraces),
    or<DailyAggregateRow[]>("overview_daily_aggregates", [], readDailyAggregates),
    or("overview_pending_rewrites", 0, readPendingRewrites),
    or("overview_sdk_activity", null, readSdkDays),
    or("overview_sdk_previous", null, readSdkPrevious),
    or("overview_sdk_latest", null, readSdkLatestAt),
    or("overview_intents", READ_FAILED, readIntentsGlance),
    or("overview_tasks", READ_FAILED, readTasksGlance),
    or("overview_self_corrections", unavailableSelfCorrectionsCard(project.id, healthWindow), () =>
      loadSelfCorrectionsCard(project.id, healthWindow),
    ),
    or("overview_prompt_cache", null, readPromptCache),
  ]);

  return assembleOverview({
    project,
    window,
    days: range.days,
    reads: {
      traces,
      previous,
      dailyTraces,
      recentRuns: recent,
      runTasks: recentTasks,
      telemetry,
      dailyAggregates,
      health,
      healthLimits,
      healthWindow,
      pendingRewrites,
      fixes,
      sdkDays,
      sdkPrevious,
      sdkLatestAt,
      intents,
      tasks,
      corrections,
      promptCache,
    },
  });
}

/** An issue's panel on Agent health, landing on its row too. */
export function issuePanelHref(healthHref: string, issueId: string): string {
  const [path, query] = healthHref.split("?");
  const params = new URLSearchParams(query ?? "");
  params.set("peek", `issue:${issueId}`);
  // The signal card's anchor (`signalAnchorId` in components/console/health/anchors.ts),
  // spelled here because lib/ never imports the UI.
  return `${path}?${params.toString()}#signal-${issueId}`;
}

/**
 * Where a fix opens: a description update on Quality › Descriptions (its
 * rewrite when Quality drafted it, else its tool), any other fix on Fixes.
 */
export function fixTarget(
  projectId: string,
  fix: Pick<Fix, "id" | "kind" | "source" | "subject">,
): string {
  if (fix.kind === "rewrite") {
    if (fix.source === "rewrite") return descriptionsHref(projectId, { peek: fix.id });
    const tool = fix.subject.tools[0]?.id;
    if (tool) return descriptionsHref(projectId, { tool });
  }
  return fixHref(projectId, { peek: fix.id });
}

/** Turns the reads into the page model. Pure: the loader's rules, testable without a database. */
export function assembleOverview({
  project,
  window,
  days,
  reads,
}: {
  project: OverviewProject;
  window: OverviewWindow;
  /** The window's UTC days, oldest first. */
  days: readonly string[];
  reads: OverviewReads;
}): OverviewData {
  const root = projectRoot(project.id);
  const rangeParam = overviewRangeParam(window);
  const dashboard = buildDashboardModel(reads.dailyAggregates, [...days]);
  const contextSuggestions = buildSuggestions(dashboard);
  const context = buildContextSplit(dashboard);
  const health = reads.health ? applyPlanLimits(reads.health, reads.healthLimits) : null;
  const healthHref = health ? agentHealthHref(project.id, reads.healthWindow) : null;
  const lastEventAt = newest(
    reads.telemetry ? latestEventAt(reads.telemetry) : null,
    reads.sdkLatestAt,
  );

  const glance: Glance = {
    intents: intentsGlance(project.id, reads.intents),
    tasks: tasksGlance(project.id, reads.tasks),
    selfCorrections: selfCorrectionsGlance(reads.corrections),
    fixes: fixesGlance(project.id, reads.fixes),
  };
  const attention = overviewAttention({
    projectId: project.id,
    window,
    traces: reads.traces,
    health,
    healthWindow: reads.healthWindow,
    fixes: reads.fixes,
    pendingRewrites: reads.pendingRewrites,
    tasks: glance.tasks,
    unanswered: glance.intents.unanswered,
    contextSuggestions,
    contextSplit: context,
  });

  return {
    project,
    root,
    window,
    rangeParam,
    lastEventAt,
    // A failed diagnostics read must not pass for an empty project.
    hasTelemetry:
      reads.telemetry === null || lastEventAt !== null || (reads.traces?.count ?? 0) > 0,
    sdk: overviewSdk(reads, days),
    traces: reads.traces,
    previous: reads.previous,
    series: dailyCounts(reads.traces?.volume ?? [], days),
    daily: overviewDaily(reads, days),
    recentRuns: reads.recentRuns,
    runTasks: Object.fromEntries(
      [...reads.runTasks].flatMap(([traceId, taskId]) => {
        const task = glance.tasks.byId[taskId];
        return task ? [[traceId, task]] : [];
      }),
    ),
    health:
      health && healthHref
        ? {
            href: healthHref,
            windowDays: reads.healthWindow,
            firstTry: firstTryTile(health),
          }
        : null,
    attention,
    glance,
    context,
    contextSuggestions,
    promptCacheHitRate: promptCacheHitRate(reads.promptCache ?? null),
  };
}

/** "Needs attention" from its reads. `fixes` is null when it could not be read. */
export function overviewAttention({
  projectId,
  window,
  traces,
  health,
  healthWindow,
  fixes,
  pendingRewrites,
  tasks,
  unanswered,
  contextSuggestions,
  contextSplit,
}: {
  projectId: string;
  window: OverviewWindow;
  traces: Pick<TraceAggregateSummary, "count" | "errorCount"> | null;
  /** Cut to the plan; null when Agent health is off. */
  health: Pick<HealthPageModel, "signals" | "lockedCount"> | null;
  healthWindow: WindowDays;
  fixes: FixesSlice | null;
  pendingRewrites: number | null;
  tasks: Pick<TasksGlance, "byId" | "steps">;
  unanswered: readonly UnansweredIntent[];
  contextSuggestions: readonly Suggestion[];
  contextSplit: ContextSplit | null;
}): Attention {
  const root = projectRoot(projectId);
  const healthHref = health ? agentHealthHref(projectId, healthWindow) : null;
  // An issue opens the fix that resolves it, when Fixes has one.
  const fixLinks = new Map<string, string>();
  for (const fix of [...(fixes?.open ?? []), ...(fixes?.applied ?? [])]) {
    for (const issue of fix.issues)
      if (!fixLinks.has(issue.id)) fixLinks.set(issue.id, fixTarget(projectId, fix));
  }
  // What Fixes can apply, plan included; Quality's own count when Fixes could not be read.
  const rewrites = fixes
    ? fixes.rewritesOn
      ? applicableDescriptions(fixes)
      : null
    : pendingRewrites;
  return buildAttention({
    errors: {
      count: traces?.errorCount ?? 0,
      total: traces?.count ?? 0,
      href: `${root}/traces?range=${overviewRangeParam(window)}&errorOnly=1`,
    },
    issues: health?.signals ?? [],
    lockedIssues: health?.lockedCount ?? 0,
    issueHref: (issueId) => (healthHref ? issuePanelHref(healthHref, issueId) : root),
    fixHref: (issueId) => fixLinks.get(issueId) ?? null,
    healthHref,
    tasks: tasks.byId,
    taskSteps: tasks.steps,
    unanswered,
    pendingRewrites:
      rewrites === null ? null : { count: rewrites, href: descriptionsHref(projectId) },
    contextSuggestions,
    contextSplit,
    contextPeek: CONTEXT_PEEK,
  });
}

/** The SDK activity under the stats; null when it could not be read. */
export function overviewSdk(
  { sdkDays, sdkPrevious }: Pick<OverviewReads, "sdkDays" | "sdkPrevious">,
  days: readonly string[],
): OverviewData["sdk"] {
  if (!sdkDays) return null;
  const byDay = new Map(sdkDays.map((row) => [row.day, row]));
  return {
    current: sumSdk(sdkDays),
    previous: sdkPrevious,
    days: days.map((day) => {
      const row = byDay.get(day);
      return {
        searches: row?.searches ?? 0,
        toolCalls: row?.toolCalls ?? 0,
        skillRuns: row?.skillRuns ?? 0,
      };
    }),
  };
}

/** The days under the trace stats. */
export function overviewDaily(
  { traces, dailyTraces }: Pick<OverviewReads, "traces" | "dailyTraces">,
  days: readonly string[],
): OverviewDaily {
  const rows = dailyTraces ?? [];
  return {
    failedShare: dailyFailureShares(traces?.volume ?? [], days),
    duration: dailyReadings(rows, days, (row) =>
      row.traceCount > 0 ? row.averageLatencyMs : null,
    ),
    spend: dailyReadings(rows, days, (row) => (row.traceCount > 0 ? row.costUsd : null)),
  };
}

/** The first try tile once there is a reading, for the stat row. */
export function firstTryTile(health: HealthPageModel): HealthTile | null {
  if (healthReadiness(health) !== "ready") return null;
  return (
    health.tiles.find(
      (tile) => (tile.key === "top_5" || tile.key === "first_try") && tile.value !== null,
    ) ?? null
  );
}

function sumSdk(days: readonly SdkActivity[]): SdkActivity {
  return days.reduce(
    (sum, day) => ({
      searches: sum.searches + day.searches,
      toolCalls: sum.toolCalls + day.toolCalls,
      skillRuns: sum.skillRuns + day.skillRuns,
    }),
    { searches: 0, toolCalls: 0, skillRuns: 0 },
  );
}
