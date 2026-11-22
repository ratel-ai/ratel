import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type { SignalFigure, SignalFixRoute } from "@/lib/readings/trace-signals/view";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";

/**
 * The small vocabulary every kind's card copy is written with (`claims-model.ts`,
 * `claims-otel.ts`): counts with grouping, shares read from their counts, and
 * the context a kind's copy function receives.
 */

export type Part = string | { chip: string };

export const count = (n: number): string => Math.round(n).toLocaleString("en-US");
/** A stored share as a whole percent: a real but tiny share is "<1%", never "0%". */
export const pct = (share: number): string => formatSharePercent(share);

/**
 * `k` of `n` as a whole percent, from the counts rather than a stored rounded
 * share, so the words can never contradict the raw count beside them: none is
 * "0%", all is "100%", and anything in between is never printed as either
 * ("<1%", ">99%"). Falls back to the stored share when a count is missing.
 */
export function shareText(k: number, n: number, stored = 0): string {
  if (!(n > 0) || !Number.isFinite(k)) return pct(stored);
  if (k <= 0) return "0%";
  if (k >= n) return "100%";
  return formatSharePercent(k / n);
}

export function num(metrics: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

export function waiting(seconds: number): string {
  if (seconds < 120) return `About ${count(seconds)} seconds of waiting`;
  const minutes = seconds / 60;
  if (minutes < 120) return `About ${count(minutes)} minutes of waiting`;
  return `About ${count(minutes / 60)} hours of waiting`;
}

export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${Math.round(n) === 1 ? one : many}`;
}

export interface KindCopy {
  parts: Part[];
  figure: SignalFigure;
  cost: string;
  fix: string;
  caveat?: string;
}

export type Ctx = {
  r: SignalRecord;
  m: Readonly<Record<string, unknown>>;
  name: (id: string | undefined) => string;
  a: string;
  b: string;
  period: string;
  route: SignalFixRoute;
  /** Model-written workflow names by workflow id, when the page loaded them. */
  labels?: WorkflowLabels;
};

/** A share figure; with its counts the display is read from them (see {@link shareText}). */
export function share(value: number, raw: string, k?: number, n?: number): SignalFigure {
  const display = k !== undefined && n !== undefined ? shareText(k, n, value) : pct(value);
  return { value, unit: "share", display, raw };
}
