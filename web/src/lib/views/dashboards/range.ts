import {
  exactInstants,
  resolveTraceRange,
  type TraceListSearchParams,
} from "@/lib/synthesis/traces/view";
import { type DashboardRange, EXACT_RANGE } from "@/lib/views/dashboards/links";

/** A widget's time range: the presets, whole days and exact instants of the Traces page. */

export interface WidgetRange extends DashboardRange {
  since: Date;
  until: Date;
}

export function resolveWidgetRange(params: TraceListSearchParams, now: Date): WidgetRange {
  const exact = exactInstants(params);
  if (exact) return exactly(exact.since, exact.until);
  const { preset, from, to, since, until } = resolveTraceRange(params, now);
  return { preset, from, to, since, until };
}

/** Why the range of an address cannot be shown, or null. */
export function rangeProblem(params: TraceListSearchParams): string | null {
  return params.range === EXACT_RANGE && !exactInstants(params)
    ? "The time range of the link is damaged."
    : null;
}

/** Two instants as a range. */
export function exactly(since: Date, until: Date): WidgetRange {
  return {
    preset: EXACT_RANGE,
    from: since.toISOString(),
    to: until.toISOString(),
    since,
    until,
  };
}
