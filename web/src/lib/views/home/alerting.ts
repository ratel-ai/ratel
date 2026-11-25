import { MISSING } from "@/lib/synthesis/traces/v2/format";
import { measuredText, unitOf } from "@/lib/views/alerts/format";
import { alertHref, alertsHref } from "@/lib/views/alerts/links";
import type { AlertingRule } from "@/lib/views/alerts/types";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";

/** An alert rule that alerts now: "Too many errors  67%  above 50% · 12m ago". */
export interface AlertRow {
  id: string;
  name: string;
  value: string;
  condition: string;
  /** How long ago it started to alert; null when that is not known. */
  since: string | null;
  href: string;
}

/** The Overview's Alerts widget. Text only, so an MCP App view draws it as it is. */
export interface FocusedAlerts {
  /** Newest change first. */
  items: AlertRow[];
  href: string;
}

export function alertsWidget(
  projectId: string,
  rules: readonly AlertingRule[],
  now: Date,
): FocusedAlerts {
  return {
    items: rules.map((rule) => {
      const unit = unitOf(rule.query);
      return {
        id: rule.id,
        name: rule.name,
        value: rule.lastValue === null ? MISSING : measuredText(rule.lastValue, unit),
        condition: `${rule.operator} ${measuredText(rule.threshold, unit)}`,
        since: rule.stateChangedAt ? relativeTimeLabel(rule.stateChangedAt, now) : null,
        href: alertHref(projectId, rule.id),
      };
    }),
    href: alertsHref(projectId),
  };
}
