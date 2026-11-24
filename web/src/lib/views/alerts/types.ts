import type { WidgetInput } from "@/lib/views/dashboards/types";

export const ALERT_OPERATORS = ["above", "below"] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

export const ALERT_WINDOWS = [5, 15, 60, 1440] as const;
/** In minutes. */
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

export const ALERT_STATES = ["ok", "alerting", "no_data"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/** The metric query of a widget, without a grouping: an alert compares one number. */
export type AlertQuery = Pick<WidgetInput, "metric" | "aggregation" | "filter" | "scorerId">;

export interface AlertCondition {
  operator: AlertOperator;
  threshold: number;
  windowMinutes: AlertWindow;
}

/** A rule as a person edits it. */
export interface AlertDraft extends AlertCondition {
  name: string;
  query: AlertQuery;
}

export interface AlertRule extends AlertDraft {
  id: string;
  projectId: string;
  enabled: boolean;
  state: AlertState;
  /** The last message said "firing": the next one can only be a recovery. */
  firing: boolean;
  lastValue: number | null;
  stateChangedAt: Date | null;
}

/** What a state change tells people. A change to or from "no data" may tell nothing. */
export type AlertNoticeKind = "fire" | "recovery";

export const MAX_ALERT_RULES = 100;
export const MAX_ALERT_NAME = 80;
