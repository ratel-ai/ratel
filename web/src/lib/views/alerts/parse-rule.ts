import { z } from "zod";
import type { MetricQuery } from "@/lib/contracts/query";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import {
  ALERT_OPERATORS,
  ALERT_WINDOWS,
  type AlertDraft,
  MAX_ALERT_NAME,
} from "@/lib/views/alerts/types";
import { parseOfferedQuery } from "@/lib/views/dashboards/parse-widget";

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
  const parsedQuery = parseAlertQuery(rawQuery, features);
  if (!parsedQuery.ok) return parsedQuery;
  return { ok: true, draft: { ...condition, name, query: parsedQuery.query } };
}

/** The query alone: a rule's, or the one a new alert starts from. */
export function parseAlertQuery(
  raw: unknown,
  features: MetricFeatures,
): { ok: true; query: MetricQuery } | { ok: false; error: string } {
  const parsed = parseOfferedQuery(raw, features);
  if (!parsed.ok) return parsed;
  const { query } = parsed;
  if (query.kind !== "metric")
    return { ok: false, error: `An alert compares one number: a ${query.kind} has none.` };
  if (query.dimensions.length > 0)
    return { ok: false, error: "An alert cannot be grouped: it compares one number." };
  return { ok: true, query };
}

/** A rule's query as it is stored, under the same contract; null with the reason when it fails. */
export function storedQuery(
  raw: unknown,
): { query: MetricQuery; problem: null } | { query: null; problem: string } {
  // Every switch on: a rule whose switch is off is not broken.
  const parsed = parseAlertQuery(raw, { customMonitoring: true });
  return parsed.ok
    ? { query: parsed.query, problem: null }
    : { query: null, problem: parsed.error };
}
