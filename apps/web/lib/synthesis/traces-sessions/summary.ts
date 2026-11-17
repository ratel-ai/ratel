import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { loadOrFallback, type ResilientReadDeps } from "@/lib/platform/resilient-read";
import { reportServerException } from "@/lib/platform/telemetry";
import { formatSpanKind } from "@/lib/synthesis/traces/format";
import { buildVolumeModel, type VolumeModel } from "@/lib/synthesis/traces/v2/volume";
import {
  getLogsAggregate,
  getSessionsAggregate,
  getSpansAggregate,
  type LogsAggregate,
  type SessionsAggregate,
  type SpansAggregate,
  type TabAggregateOptions,
} from "./tab-aggregates";
import {
  LOG_LEVELS,
  type LogLevel,
  logLevelOf,
  type TracesTab,
  type TracesTabSummary,
  type TracesWindow,
  tracesWindowRange,
} from "./timeframe";

/**
 * The summary inside each Traces tab (`cloud-traces-sessions`, RC-331): the
 * timeframe in `?window=` and the numbers of that tab only. Sessions:
 * sessions, failed, typical duration and cost. Spans: spans, errors, p50/p95
 * and kinds. Logs: records, levels and errors. Each has a volume chart. Only
 * the summary reads the timeframe; the tab's list keeps its own. Each read is
 * supplementary: on its 5 s timeout, or any failure, the summary says the
 * numbers are unavailable and the tab still works.
 */

export interface TabSummaryDeps extends ResilientReadDeps {
  now: () => Date;
  sessions: (projectId: string, options: TabAggregateOptions) => Promise<SessionsAggregate>;
  spans: (projectId: string, options: TabAggregateOptions) => Promise<SpansAggregate>;
  logs: (projectId: string, options: TabAggregateOptions) => Promise<LogsAggregate>;
}

const OPERATION: Readonly<Record<TracesTab, string>> = {
  sessions: "traces_summary_sessions",
  spans: "traces_summary_spans",
  logs: "traces_summary_logs",
};
const logger = getLogger("traces-sessions/summary");
const defaultDeps: TabSummaryDeps = {
  now: () => new Date(),
  sessions: (projectId, options) =>
    supplementary("sessions", (db) => getSessionsAggregate(projectId, options, db)),
  spans: (projectId, options) =>
    supplementary("spans", (db) => getSpansAggregate(projectId, options, db)),
  logs: (projectId, options) =>
    supplementary("logs", (db) => getLogsAggregate(projectId, options, db)),
  logError: (message, error, fields) => logger.error({ ...fields, err: error }, message),
  reportServerException,
};

/** One tab's summary for a timeframe, or the unavailable state when its read fails. */
export async function loadTabSummary(
  projectId: string,
  tab: TracesTab,
  window: TracesWindow,
  deps: TabSummaryDeps = defaultDeps,
): Promise<TracesTabSummary> {
  const range = tracesWindowRange(window, deps.now());
  const options: TabAggregateOptions = {
    since: range.since,
    until: range.until,
    volumeBucket: window === "30d" ? "day" : "hour",
  };
  const volume = (points: SessionsAggregate["volume"]) =>
    withinWindow(
      buildVolumeModel({ from: range.from, to: range.to, points }),
      range.since,
      range.until,
    );
  return loadOrFallback<TracesTabSummary>(
    {
      operation: OPERATION[tab],
      distinctId: `project:${projectId}`,
      fallback: { status: "unavailable", tab, window },
      load: async (): Promise<TracesTabSummary> => {
        if (tab === "sessions") {
          const aggregate = await deps.sessions(projectId, options);
          return {
            status: "ok",
            tab,
            window,
            sessions: aggregate.count,
            failed: aggregate.failed,
            typicalDurationMs: aggregate.count > 0 ? aggregate.p50DurationMs : null,
            costUsd: aggregate.costUsd,
            volume: volume(aggregate.volume),
          };
        }
        if (tab === "spans") {
          const aggregate = await deps.spans(projectId, options);
          return {
            status: "ok",
            tab,
            window,
            spans: aggregate.count,
            errors: aggregate.errorCount,
            p50DurationMs: aggregate.count > 0 ? aggregate.p50DurationMs : null,
            p95DurationMs: aggregate.count > 0 ? aggregate.p95DurationMs : null,
            kinds: aggregate.kinds.map((row) => ({
              kind: formatSpanKind(row.kind),
              count: row.count,
            })),
            volume: volume(aggregate.volume),
          };
        }
        const aggregate = await deps.logs(projectId, options);
        const levels = levelsOf(aggregate.severities);
        return {
          status: "ok",
          tab,
          window,
          logs: aggregate.count,
          errors: levels
            .filter((row) => row.level === "error" || row.level === "fatal")
            .reduce((total, row) => total + row.count, 0),
          levels,
          volume: volume(aggregate.volume),
        };
      },
    },
    deps,
  );
}

function supplementary<T>(tab: TracesTab, read: (db: BoundReadDb) => Promise<T>): Promise<T> {
  return withStatementTimeout(read, {
    operation: OPERATION[tab],
    timeoutMs: supplementaryReadTimeoutMs(),
  });
}

/** The model's buckets cover whole UTC days; the chart draws only those the timeframe touches. */
function withinWindow(model: VolumeModel, since: Date, until: Date): VolumeModel {
  return {
    ...model,
    buckets: model.buckets.filter(
      (bucket) => bucket.endMs > since.getTime() && bucket.startMs < until.getTime(),
    ),
  };
}

/** Severity numbers folded into OTel levels, in level order; levels with no records are left out. */
function levelsOf(severities: LogsAggregate["severities"]): { level: LogLevel; count: number }[] {
  const counts = new Map<LogLevel, number>();
  for (const row of severities)
    counts.set(
      logLevelOf(row.severityNumber),
      (counts.get(logLevelOf(row.severityNumber)) ?? 0) + row.count,
    );
  return LOG_LEVELS.flatMap((level) =>
    counts.get(level) ? [{ level, count: counts.get(level) ?? 0 }] : [],
  );
}
