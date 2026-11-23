import type { TraceWindow } from "@/lib/synthesis/traces/queries";
import type { VolumeModel } from "@/lib/synthesis/traces/v2/volume";

/**
 * The timeframe (`?window=`) of the summary inside each Traces tab, and the
 * shape of each tab's summary. Pure, so the summary (a client component)
 * reads it without the server loader (`./summary`).
 */

export const TRACES_WINDOWS = ["24h", "7d", "30d"] as const;
export type TracesWindow = (typeof TRACES_WINDOWS)[number];

export const TRACES_WINDOW_PARAM = "window";
export const DEFAULT_TRACES_WINDOW: TracesWindow = "7d";

export const TRACES_WINDOW_LABEL: Readonly<Record<TracesWindow, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** The tabs that each show their own summary. */
export const TRACES_TABS = ["sessions", "spans", "logs"] as const;
export type TracesTab = (typeof TRACES_TABS)[number];

/** OTel severity bands (SeverityNumber 1–24); 0 is unspecified. */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "unspecified",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

interface TabSummaryBase {
  status: "ok";
  window: TracesWindow;
  volume: VolumeModel;
}

/** Sessions tab: sessions, open or closed, by their last activity in the window, as the list shows them (RC-752). */
export interface SessionsTabSummary extends TabSummaryBase {
  tab: "sessions";
  sessions: number;
  failed: number;
  /** The median session duration; null without sessions. */
  typicalDurationMs: number | null;
  costUsd: number;
}

/** Spans tab: every span that started in the window. */
export interface SpansTabSummary extends TabSummaryBase {
  tab: "spans";
  spans: number;
  errors: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** Span kinds, most spans first. */
  kinds: { kind: string; count: number }[];
}

/** Logs tab: every log record that occurred in the window. */
export interface LogsTabSummary extends TabSummaryBase {
  tab: "logs";
  logs: number;
  /** Error and fatal records. */
  errors: number;
  /** Severity levels with records, in LOG_LEVELS order. */
  levels: { level: LogLevel; count: number }[];
}

export type TracesTabSummary =
  | SessionsTabSummary
  | SpansTabSummary
  | LogsTabSummary
  | { status: "unavailable"; tab: TracesTab; window: TracesWindow };

const HOUR_MS = 3_600_000;
const WINDOW_HOURS: Readonly<Record<TracesWindow, number>> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
};

/** A repeated or unknown value reads as its first known value, else the default. */
export function parseTracesWindow(
  value: string | readonly string[] | null | undefined,
): TracesWindow {
  const first = Array.isArray(value) ? value[0] : value;
  return TRACES_WINDOWS.find((window) => window === first) ?? DEFAULT_TRACES_WINDOW;
}

/** The window ends now; `from`/`to` are the UTC days it touches, for the volume buckets. */
export function tracesWindowRange(
  window: TracesWindow,
  now: Date,
): TraceWindow & { from: string; to: string } {
  const since = new Date(now.getTime() - WINDOW_HOURS[window] * HOUR_MS);
  return {
    since,
    until: now,
    from: since.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

/** The query with this timeframe; the default is left out of the URL. */
export function withTracesWindow(search: string, window: TracesWindow): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  params.delete(TRACES_WINDOW_PARAM);
  if (window !== DEFAULT_TRACES_WINDOW) params.set(TRACES_WINDOW_PARAM, window);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** A repeated or unknown value reads as its first known value, else Sessions. */
export function parseTracesTab(value: string | readonly string[] | null | undefined): TracesTab {
  const first = Array.isArray(value) ? value[0] : value;
  return TRACES_TABS.find((tab) => tab === first) ?? "sessions";
}

/** The OTel severity band of a SeverityNumber. */
export function logLevelOf(severityNumber: number): LogLevel {
  if (!Number.isInteger(severityNumber) || severityNumber < 1 || severityNumber > 24)
    return "unspecified";
  return LOG_LEVELS[Math.floor((severityNumber - 1) / 4)] ?? "unspecified";
}
