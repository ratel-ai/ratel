import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  type DailyAggregateRow,
  getDailyAggregates,
  getPromptCacheTotals,
  type PromptCacheTotals,
} from "@/lib/ingest/otlp/queries";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import type {
  AgentHealthPlanLimits,
  HealthPageModel,
  WindowDays,
} from "@/lib/readings/trace-signals/view";
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
import { countAlertRuleStates, listAlertingRules } from "@/lib/views/alerts/store";
import type { AlertingRule, AlertRuleCounts } from "@/lib/views/alerts/types";
import { loadFixes } from "@/lib/views/fixes/load";
import { loadHealthPageModel } from "@/lib/views/health/page-model";
import type { FixesSlice, IntentsRead, TasksRead } from "@/lib/views/home/glance";
import { readIntents, readRunTasks, readTasks } from "@/lib/views/home/glance-queries";

/**
 * The Overview's reads, one function each, under a statement timeout. Every one may throw: the
 * page that calls it decides what a failure costs. Both Overviews (`load`, `focused-load`) read
 * through here, so a number is the same on both.
 */

export interface OverviewReadScope {
  projectId: string;
  organization: Parameters<typeof loadFixes>[0]["organization"];
  current: { since: Date; until: Date };
  /** The window that the change figures compare with. */
  before: { since: Date; until: Date };
  now: Date;
  /** Another database than the pool's, in tests. */
  db?: ReturnType<typeof getDb>;
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

const RECENT_RUNS = 5;

export const readTraces = (at: OverviewReadScope): Promise<TraceAggregateSummary> =>
  withStatementTimeout((db) => getTraceAggregates(at.projectId, at.current, db), {
    operation: "overview_trace_aggregate",
    db: at.db,
  });

export const readRecentRuns = (at: OverviewReadScope): Promise<TraceSummary[]> =>
  withStatementTimeout(
    async (db) => (await listTraces(at.projectId, { ...at.current, limit: RECENT_RUNS }, db)).items,
    { operation: "overview_recent_runs", db: at.db },
  );

export const readTasksOfRuns = (
  at: OverviewReadScope,
  runs: TraceSummary[],
): Promise<ReadonlyMap<string, string>> =>
  supplementary(at, "overview_run_tasks", (db) => readRunTasks(db, at.projectId, runs));

export const readTelemetry = (at: OverviewReadScope): Promise<TracesIngestDiagnostics> =>
  supplementary(at, "overview_telemetry", (db) => getTracesIngestDiagnostics(at.projectId, db));

/** The Overview shows no example turns: none are read. */
export const readHealth = (
  at: OverviewReadScope,
  windowDays: WindowDays,
  limits: AgentHealthPlanLimits,
  lowConfidenceFloor?: number,
): Promise<HealthPageModel> =>
  loadHealthPageModel(
    { projectId: at.projectId, windowDays, lowConfidenceFloor },
    process.env.NODE_ENV,
    {
      getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
      ...(at.db ? { db: at.db, now: () => at.now } : {}),
    },
  );

export const readFixes = (at: OverviewReadScope): Promise<FixesSlice> =>
  loadFixes({
    projectId: at.projectId,
    organization: at.organization,
    now: at.now,
    topics: false,
    ...(at.db ? { deps: { db: at.db } } : {}),
  });

export const readPreviousTraces = (at: OverviewReadScope): Promise<TraceAggregateSummary> =>
  supplementary(at, "overview_previous_aggregate", (db) =>
    getTraceAggregates(at.projectId, at.before, db),
  );

/**
 * Off the per-trace summary table, not another pass over the spans: a spark is worth a sweep
 * interval of lag, never a second rollup.
 */
export const readDailyTraces = (at: OverviewReadScope): Promise<TraceDailyAggregate[]> =>
  supplementary(at, "overview_trace_daily", (db) =>
    getTraceDailyAggregatesFromSummaries(at.projectId, at.current, db),
  );

export const readDailyAggregates = (at: OverviewReadScope): Promise<DailyAggregateRow[]> =>
  getDailyAggregates(at.projectId, at.current.since, at.current.until, at.db);

export const readPendingRewrites = (at: OverviewReadScope): Promise<number> =>
  supplementary(at, "overview_pending_rewrites", (db) => countPendingRewrites(at.projectId, db));

export const readSdkDays = (at: OverviewReadScope): Promise<SdkDay[]> =>
  supplementary(at, "overview_sdk_activity", (db) =>
    countSdkActivityByDay(at.projectId, at.current, db),
  );

export const readSdkPrevious = (at: OverviewReadScope): Promise<SdkActivity> =>
  supplementary(at, "overview_sdk_previous", (db) => countSdkActivity(at.projectId, at.before, db));

export const readSdkLatestAt = (at: OverviewReadScope): Promise<Date | null> =>
  supplementary(at, "overview_sdk_latest", (db) => latestSdkEventAt(at.projectId, db));

export const readIntentsGlance = (at: OverviewReadScope): Promise<IntentsRead | null> =>
  supplementary(at, "overview_intents", (db) => readIntents(db, at.projectId));

export const readTasksGlance = (at: OverviewReadScope): Promise<TasksRead | null> =>
  supplementary(at, "overview_tasks", (db) => readTasks(db, at.projectId));

/** The alert rules that alert now. */
export const readAlerting = (at: OverviewReadScope): Promise<AlertingRule[]> =>
  supplementary(at, "overview_alerting_rules", (db) => listAlertingRules(at.projectId, db));

export const readAlertRuleCounts = (at: OverviewReadScope): Promise<AlertRuleCounts> =>
  supplementary(at, "overview_alert_rule_counts", (db) => countAlertRuleStates(at.projectId, db));

export const readPromptCache = (at: OverviewReadScope): Promise<PromptCacheTotals> =>
  supplementary(at, "overview_prompt_cache", (db) =>
    getPromptCacheTotals(at.projectId, at.current.since, at.current.until, db),
  );

function supplementary<T>(
  { db }: OverviewReadScope,
  operation: string,
  read: (db: BoundReadDb) => Promise<T>,
): Promise<T> {
  return withStatementTimeout(read, { operation, timeoutMs: supplementaryReadTimeoutMs(), db });
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

export function newest(a: Date | null, b: Date | null): Date | null {
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

export function latestEventAt({
  latestEventAt: event,
  latestSpanAt: span,
}: TracesIngestDiagnostics): Date | null {
  if (event === null) return span;
  if (span === null) return event;
  return event > span ? event : span;
}
