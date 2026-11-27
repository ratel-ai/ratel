import type {
  AlertCondition,
  AlertNoticeKind,
  AlertState,
  AlertWindow,
} from "@/lib/views/alerts/types";

/** The alert rules of the state machine. Pure, safe for the browser. */

/** What the catalog measured over the window. */
export interface Measurement {
  /** Null: nothing to read. A count or a sum of nothing is 0, which is a value. */
  value: number | null;
}

export interface Transition {
  state: AlertState;
  firing: boolean;
  value: number | null;
  /** The state is new: a history row. */
  changed: boolean;
  notice: AlertNoticeKind | null;
}

/** A tick is a minute and can come a little early. */
const TICK_MS = 45_000;
const LONG_WINDOW_MS = 285_000;

/**
 * The next state. "No data" keeps `firing`, so an alert that loses its data sends nothing until
 * the data says it recovered, and does not fire twice.
 */
export function nextState(
  current: { state: AlertState; firing: boolean },
  condition: Pick<AlertCondition, "operator" | "threshold">,
  measured: Measurement,
): Transition {
  const { value } = measured;
  const state = value === null ? "no_data" : breaches(value, condition) ? "alerting" : "ok";
  const firing = state === "no_data" ? current.firing : state === "alerting";
  return {
    state,
    firing,
    value,
    changed: state !== current.state,
    notice: firing === current.firing ? null : firing ? "fire" : "recovery",
  };
}

/** A value on the threshold is neither above nor below it. */
export function breaches(
  value: number,
  { operator, threshold }: Pick<AlertCondition, "operator" | "threshold">,
): boolean {
  return operator === "above" ? value > threshold : value < threshold;
}

/** The shortest time between two evaluations: each tick, or about 5 minutes for a window of a day. */
export function evaluationIntervalMs(windowMinutes: AlertWindow): number {
  return windowMinutes > 60 ? LONG_WINDOW_MS : TICK_MS;
}

/**
 * The window an evaluation reads: what became known in it. A trace is known when it ended, so by
 * its start one that is longer than the window would never be in it.
 */
export function evaluationWindow(windowMinutes: AlertWindow, now: Date) {
  return {
    since: new Date(now.getTime() - windowMinutes * 60_000),
    until: now,
    by: "known",
  } as const;
}
