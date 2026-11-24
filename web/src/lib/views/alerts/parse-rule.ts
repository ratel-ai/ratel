import { z } from "zod";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import {
  ALERT_OPERATORS,
  ALERT_WINDOWS,
  type AlertDraft,
  MAX_ALERT_NAME,
} from "@/lib/views/alerts/types";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";

const draftShape = z
  .object({
    name: z.string().trim(),
    query: z.unknown(),
    operator: z.enum(ALERT_OPERATORS),
    threshold: z.number().finite().nonnegative(),
    windowMinutes: z.literal(ALERT_WINDOWS),
  })
  .strict();

export type ParsedRule = { ok: true; draft: AlertDraft } | { ok: false; error: string };

/** A rule from outside: its shape, then the metric query under the same rules as a widget's. */
export function parseRule(raw: unknown, features: MetricFeatures): ParsedRule {
  const parsed = draftShape.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "threshold")
      return { ok: false, error: "The threshold is a number of 0 or more." };
    return { ok: false, error: "The alert settings are invalid." };
  }
  const { name, query: rawQuery, ...condition } = parsed.data;
  if (!name) return { ok: false, error: "Give the alert a name." };
  if (name.length > MAX_ALERT_NAME)
    return { ok: false, error: `An alert name can have ${MAX_ALERT_NAME} characters.` };
  const { metric, aggregation, filter, scorerId, ...rest } = record(rawQuery);
  if (Object.keys(rest).length > 0) return { ok: false, error: "The alert settings are invalid." };
  const checked = parseWidget(
    {
      metric,
      aggregation,
      ...(filter === undefined ? {} : { filter }),
      ...(scorerId === undefined ? {} : { scorerId }),
      chart: "line",
      width: "full",
    },
    features,
  );
  if (!checked.ok) return checked;
  const { widget } = checked;
  return {
    ok: true,
    draft: {
      ...condition,
      name,
      query: {
        metric: widget.metric,
        aggregation: widget.aggregation,
        filter: widget.filter,
        ...(widget.scorerId ? { scorerId: widget.scorerId } : {}),
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
