import type { MetricQuery } from "@/lib/contracts/query";

export const ALERT_OPERATORS = ["above", "below"] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

export const ALERT_WINDOWS = [5, 15, 60, 1440] as const;
/** In minutes. */
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

export const ALERT_STATES = ["ok", "alerting", "no_data"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export interface AlertCondition {
  operator: AlertOperator;
  threshold: number;
  windowMinutes: AlertWindow;
}

/** A rule as a person edits it. */
export interface AlertDraft extends AlertCondition {
  name: string;
  /** The query object of a widget, without dimensions: an alert compares one number. */
  query: MetricQuery;
}

export interface AlertRule extends Omit<AlertDraft, "query"> {
  id: string;
  /** Null: what is stored is no query any more, and the rule needs attention. */
  query: MetricQuery | null;
  /** Why it needs attention. */
  problem: string | null;
  projectId: string;
  enabled: boolean;
  state: AlertState;
  /** The last message said "firing": the next one can only be a recovery. */
  firing: boolean;
  lastValue: number | null;
  stateChangedAt: Date | null;
}

/** A rule that alerts now, as the Overview shows it. */
export type AlertingRule = Pick<
  AlertRule,
  "id" | "name" | "operator" | "threshold" | "lastValue" | "stateChangedAt"
> & { query: MetricQuery };

/** What a state change tells people. A change to or from "no data" may tell nothing. */
export type AlertNoticeKind = "fire" | "recovery";

export const MAX_ALERT_RULES = 100;
export const MAX_ALERT_NAME = 80;
