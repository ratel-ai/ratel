import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { projectRoot } from "@/lib/console/navigation";
import { type DailyAggregateRow, getDailyAggregates } from "@/lib/ingest/otlp/queries";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
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
import { buildDashboardModel, buildSuggestions, type Suggestion } from "@/lib/synthesis/dashboard";
import { matchQualityProposals } from "@/lib/synthesis/match-quality/schema";
import {
  getTraceAggregates,
  getTraceDailyAggregatesFromSummaries,
  getTracesIngestDiagnostics,
  listTraces,
  type TraceAggregateSummary,
  type TraceDailyAggregate,
  type TraceSummary,
  type TracesIngestDiagnostics,
} from "@/lib/synthesis/traces/queries";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";
import { fixHref } from "@/lib/views/fixes/href";
import { loadFixes } from "@/lib/views/fixes/load";
import type { Fix } from "@/lib/views/fixes/types";
import { loadHealthPageModel, pendingHealthModel } from "@/lib/views/health/page-model";
import {
  loadSelfCorrectionsCard,
  type SelfCorrectionsCardModel,
  unavailableSelfCorrectionsCard,
} from "@/lib/views/health/self-corrections/card";
import { type Attention, buildAttention } from "@/lib/views/home/attention";
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
  type TasksRead,
  tasksGlance,
} from "@/lib/views/home/glance";
import { readIntents, readRunTasks, readTasks } from "@/lib/views/home/glance-queries";
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

export type { FixesSlice } from "@/lib/views/home/glance";

type FixesOrganization = Parameters<typeof loadFixes>[0]["organization"];
type LimitOrganization = Parameters<typeof getAgentHealthLimits>[0];

/** The Panel the Spend stat and the context rows open. */
export const CONTEXT_PEEK = "context";

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

/** What the Ratel SDK reported in a window: searches, tool calls and skill runs. */
export interface SdkActivity {
  searches: number;
  toolCalls: number;
  skillRuns: number;
}

/** One UTC day of SDK activity. */
export interface SdkDay extends SdkActivity {
  day: string;
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

const RECENT_RUNS = 5;

/**
 * Overview v2's reads, in one round. Every read runs under a statement
 * timeout and degrades on its own (logged and reported by `loadOrFallback`),
 * so one slow aggregate on a dense project costs a number or a tile, never
 * the page.
 *
 * Owned (ADR-0030): no feature-flag gate, since Agent health is always on
 * here; its read runs with the rest.
 */
export async function loadOverview({
  project,
  organization,
  window,
  now = new Date(),
}: {
  project: OverviewProject;
  organization: FixesOrganization & LimitOrganization;
  window: OverviewWindow;
  now?: Date;
}): Promise<OverviewData> {
  const { range } = resolveTraceListView({ range: overviewRangeParam(window) }, now);
  const current = { since: range.since, until: range.until };
  const before = previousWindow(range, window, now);
  const distinctId = `project:${project.id}`;
  const supplementary = supplementaryReadTimeoutMs();
  const healthLimits = getAgentHealthLimits(organization);
  const healthWindow = parseWindowDays(String(window), healthLimits.agentHealthWindowDays);

  function bounded<T>(
    operation: string,
    fallback: T,
    read: (db: BoundReadDb) => Promise<T>,
    timeoutMs?: number | null,
  ): Promise<T> {
    return loadOrFallback({
      operation,
      distinctId,
      fallback,
      load: () =>
        withStatementTimeout(read, {
          operation,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
    });
  }

  const recentRuns = bounded<TraceSummary[] | null>(
    "overview_recent_runs",
    null,
    async (db) => (await listTraces(project.id, { ...current, limit: RECENT_RUNS }, db)).items,
  );
  // Starts as soon as the runs are in, alongside the rest of the round.
  const runTasks = recentRuns.then((runs) =>
    runs && runs.length > 0
      ? bounded<ReadonlyMap<string, string>>(
          "overview_run_tasks",
          new Map(),
          (db) => readRunTasks(db, project.id, runs),
          supplementary,
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
  ] = await Promise.all([
    bounded<TraceAggregateSummary | null>("overview_trace_aggregate", null, (db) =>
      getTraceAggregates(project.id, current, db),
    ),
    recentRuns,
    runTasks,
    bounded<TracesIngestDiagnostics | null>(
      "overview_telemetry",
      null,
      (db) => getTracesIngestDiagnostics(project.id, db),
      supplementary,
    ),
    loadOrFallback({
      operation: "overview_agent_health",
      distinctId,
      fallback: pendingHealthModel(healthWindow),
      // The Overview shows no example turns: none are read.
      load: () =>
        loadHealthPageModel(
          { projectId: project.id, windowDays: healthWindow },
          process.env.NODE_ENV,
          {
            getLimits: async () => ({ ...healthLimits, agentHealthEvidenceTurns: 0 }),
          },
        ),
    }),
    // Each of its sources degrades on its own; this fallback covers the rest.
    loadOrFallback<FixesSlice | null>({
      operation: "overview_fixes",
      distinctId,
      fallback: null,
      load: () => loadFixes({ projectId: project.id, organization, now, topics: false }),
    }),
    bounded<TraceAggregateSummary | null>(
      "overview_previous_aggregate",
      null,
      (db) => getTraceAggregates(project.id, before, db),
      supplementary,
    ),
    // Off the per-trace summary table, not another pass over the spans: a
    // spark is worth a sweep interval of lag, never a second rollup.
    bounded<TraceDailyAggregate[] | null>(
      "overview_trace_daily",
      null,
      (db) => getTraceDailyAggregatesFromSummaries(project.id, current, db),
      supplementary,
    ),
    loadOrFallback({
      operation: "overview_daily_aggregates",
      distinctId,
      fallback: [] as DailyAggregateRow[],
      load: () => getDailyAggregates(project.id, range.since, range.until),
    }),
    bounded<number>(
      "overview_pending_rewrites",
      0,
      (db) => countPendingRewrites(project.id, db),
      supplementary,
    ),
    bounded<SdkDay[] | null>(
      "overview_sdk_activity",
      null,
      (db) => countSdkActivityByDay(project.id, current, db),
      supplementary,
    ),
    bounded<SdkActivity | null>(
      "overview_sdk_previous",
      null,
      (db) => countSdkActivity(project.id, before, db),
      supplementary,
    ),
    bounded<Date | null>(
      "overview_sdk_latest",
      null,
      (db) => latestSdkEventAt(project.id, db),
      supplementary,
    ),
    bounded<GlanceRead<IntentsRead>>(
      "overview_intents",
      READ_FAILED,
      (db) => readIntents(db, project.id),
      supplementary,
    ),
    bounded<GlanceRead<TasksRead>>(
      "overview_tasks",
      READ_FAILED,
      (db) => readTasks(db, project.id),
      supplementary,
    ),
    loadOrFallback({
      operation: "overview_self_corrections",
      distinctId,
      fallback: unavailableSelfCorrectionsCard(project.id, healthWindow),
      load: () => loadSelfCorrectionsCard(project.id, healthWindow),
    }),
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
  const tracesHref = `${root}/traces?range=${rangeParam}`;
  const lastEventAt = newest(
    reads.telemetry ? latestEventAt(reads.telemetry) : null,
    reads.sdkLatestAt,
  );

  // An issue opens the fix that resolves it, when Fixes has one.
  const fixLinks = new Map<string, string>();
  for (const fix of [...(reads.fixes?.open ?? []), ...(reads.fixes?.applied ?? [])]) {
    for (const issue of fix.issues)
      if (!fixLinks.has(issue.id)) fixLinks.set(issue.id, fixTarget(project.id, fix));
  }
  // What Fixes can apply, plan included; Quality's own count when Fixes could not be read.
  const pendingRewrites = reads.fixes
    ? reads.fixes.rewritesOn
      ? applicableDescriptions(reads.fixes)
      : null
    : reads.pendingRewrites;
  const glance: Glance = {
    intents: intentsGlance(project.id, reads.intents),
    tasks: tasksGlance(project.id, reads.tasks),
    selfCorrections: selfCorrectionsGlance(reads.corrections),
    fixes: fixesGlance(project.id, reads.fixes),
  };
  const attention = buildAttention({
    errors: {
      count: reads.traces?.errorCount ?? 0,
      total: reads.traces?.count ?? 0,
      href: `${tracesHref}&errorOnly=1`,
    },
    issues: health?.signals ?? [],
    lockedIssues: health?.lockedCount ?? 0,
    issueHref: (issueId) => (healthHref ? issuePanelHref(healthHref, issueId) : root),
    fixHref: (issueId) => fixLinks.get(issueId) ?? null,
    healthHref,
    tasks: glance.tasks.byId,
    taskSteps: glance.tasks.steps,
    unanswered: glance.intents.unanswered,
    pendingRewrites:
      pendingRewrites === null
        ? null
        : { count: pendingRewrites, href: descriptionsHref(project.id) },
    contextSuggestions,
    contextSplit: context,
    contextPeek: CONTEXT_PEEK,
  });

  const sdkDays = reads.sdkDays;
  const sdkCurrent = sdkDays ? sumSdk(sdkDays) : null;
  const sdkByDay = new Map((sdkDays ?? []).map((row) => [row.day, row]));
  const dailyTraces = reads.dailyTraces ?? [];

  return {
    project,
    root,
    window,
    rangeParam,
    lastEventAt,
    // A failed diagnostics read must not pass for an empty project.
    hasTelemetry:
      reads.telemetry === null || lastEventAt !== null || (reads.traces?.count ?? 0) > 0,
    sdk: sdkCurrent
      ? {
          current: sdkCurrent,
          previous: reads.sdkPrevious,
          days: days.map((day) => {
            const row = sdkByDay.get(day);
            return {
              searches: row?.searches ?? 0,
              toolCalls: row?.toolCalls ?? 0,
              skillRuns: row?.skillRuns ?? 0,
            };
          }),
        }
      : null,
    traces: reads.traces,
    previous: reads.previous,
    series: dailyCounts(reads.traces?.volume ?? [], days),
    daily: {
      failedShare: dailyFailureShares(reads.traces?.volume ?? [], days),
      duration: dailyReadings(dailyTraces, days, (row) =>
        row.traceCount > 0 ? row.averageLatencyMs : null,
      ),
      spend: dailyReadings(dailyTraces, days, (row) => (row.traceCount > 0 ? row.costUsd : null)),
    },
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
            firstTry:
              healthReadiness(health) === "ready"
                ? (health.tiles.find((tile) => tile.key === "first_try" && tile.value !== null) ??
                  null)
                : null,
          }
        : null,
    attention,
    glance,
    context,
    contextSuggestions,
  };
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

/** The SDK event types Overview counts: a search, a tool call, a skill run. */
const SDK_TYPES = {
  search: "searches",
  invoke_start: "toolCalls",
  skill_invoke: "skillRuns",
} as const;
type SdkType = keyof typeof SDK_TYPES;

const sdkAt = () => sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

function sdkWhere(projectId: string, window: { since: Date; until: Date }) {
  const at = sdkAt();
  return and(
    eq(traceEvents.projectId, projectId),
    inArray(traceEvents.type, Object.keys(SDK_TYPES)),
    gte(at, window.since),
    lt(at, window.until),
  );
}

/** SDK events in a window, by kind. Uses the (project, type, time) index. */
export async function countSdkActivity(
  projectId: string,
  window: { since: Date; until: Date },
  db: BoundReadDb = getDb(),
): Promise<SdkActivity> {
  const rows = await db
    .select({ type: traceEvents.type, count: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(sdkWhere(projectId, window))
    .groupBy(traceEvents.type);
  const activity: SdkActivity = { searches: 0, toolCalls: 0, skillRuns: 0 };
  for (const row of rows) {
    const key = SDK_TYPES[row.type as SdkType];
    if (key) activity[key] = row.count;
  }
  return activity;
}

/** SDK events in a window, by UTC day and kind, oldest day first; days without any are left out. */
export async function countSdkActivityByDay(
  projectId: string,
  window: { since: Date; until: Date },
  db: BoundReadDb = getDb(),
): Promise<SdkDay[]> {
  const day = sql<string>`to_char(date_trunc('day', ${sdkAt()} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, type: traceEvents.type, count: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(sdkWhere(projectId, window))
    .groupBy(day, traceEvents.type);
  const byDay = new Map<string, SdkDay>();
  for (const row of rows) {
    const key = SDK_TYPES[row.type as SdkType];
    if (!key) continue;
    const entry = byDay.get(row.day) ?? { day: row.day, searches: 0, toolCalls: 0, skillRuns: 0 };
    entry[key] += row.count;
    byDay.set(row.day, entry);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * The newest SDK search, tool call or skill run, one index lookup per kind.
 * One after another: `db` is a single bounded transaction, and a connection
 * runs one query at a time (concurrent queries on it are deprecated in pg).
 */
export async function latestSdkEventAt(
  projectId: string,
  db: BoundReadDb = getDb(),
): Promise<Date | null> {
  const at = sdkAt();
  let latest: Date | null = null;
  for (const type of Object.keys(SDK_TYPES)) {
    const [row] = await db
      .select({ latest: sql<string | Date | null>`max(${at})` })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), eq(traceEvents.type, type)));
    latest = newest(latest, row?.latest ? new Date(row.latest) : null);
  }
  return latest;
}

function newest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** Suggested rewrites still waiting for a person, across every run. */
export async function countPendingRewrites(
  projectId: string,
  db: BoundReadDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matchQualityProposals)
    .where(
      and(
        eq(matchQualityProposals.projectId, projectId),
        eq(matchQualityProposals.status, "pending"),
      ),
    );
  return row?.count ?? 0;
}

function latestEventAt({
  latestEventAt: event,
  latestSpanAt: span,
}: TracesIngestDiagnostics): Date | null {
  if (event === null) return span;
  if (span === null) return event;
  return event > span ? event : span;
}
