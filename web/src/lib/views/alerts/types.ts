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
  /** Where its messages go. Empty: it notifies nobody. */
  destinationIds: string[];
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

export type AlertDestinationKind = "webhook" | "slack_channel";

/** Where messages go, as the pages show it: no secret is ever read back. */
export type AlertDestination = { id: string; name: string } & (
  | {
      kind: "webhook";
      /** The end of the URL. */
      lastFour: string;
    }
  | {
      kind: "slack_channel";
      teamId: string;
      channelId: string;
      /** Slack's code of why the app could not post there the last time. */
      accessError: string | null;
    }
);

/** What a state change tells people. A change to or from "no data" may tell nothing. */
export type AlertNoticeKind = "fire" | "recovery";

export const MAX_ALERT_RULES = 100;
export const MAX_ALERT_NAME = 80;
export const MAX_DESTINATION_NAME = 80;
