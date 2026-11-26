import { z } from "zod";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import { compileRql } from "@/lib/synthesis/rql/compile";
import {
  ALERT_OPERATORS,
  ALERT_WINDOWS,
  type AlertDraft,
  type AlertQuery,
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
    destinationIds: z.array(z.guid()).max(100).default([]),
  })
  .strict();

export type ParsedRule = { ok: true; draft: AlertDraft } | { ok: false; error: string };

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];

/**
 * A rule from outside: its shape, then the query under the same rules as a widget's. RQL text is
 * compiled here too: it must give one row with one number. `now` is when the text is compiled.
 */
export function parseRule(
  raw: unknown,
  features: MetricFeatures,
  now: Date = new Date(),
): ParsedRule {
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
  if (parsedQuery.query.kind === "sql") {
    const problem = sqlAlertProblem(parsedQuery.query.text, now);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, draft: { ...condition, name, query: parsedQuery.query } };
}

/** The query alone: a rule's, or the one a new alert starts from. */
export function parseAlertQuery(
  raw: unknown,
  features: MetricFeatures,
): { ok: true; query: AlertQuery } | { ok: false; error: string } {
  const parsed = parseOfferedQuery(raw, features);
  if (!parsed.ok) return parsed;
  const { query } = parsed;
  if (query.kind === "sql")
    return features.rql
      ? { ok: true, query }
      : { ok: false, error: "RQL is off for this project, so an alert cannot watch RQL text." };
  if (query.kind !== "metric")
    return { ok: false, error: `An alert compares one number: a ${query.kind} has none.` };
  if (query.dimensions.length > 0)
    return { ok: false, error: "An alert cannot be grouped: it compares one number." };
  return { ok: true, query };
}

/** A rule's query as it is stored, under the same contract; null with the reason when it fails. */
export function storedQuery(
  raw: unknown,
): { query: AlertQuery; problem: null } | { query: null; problem: string } {
  // Every switch on: a rule whose switch is off is not broken.
  const parsed = parseAlertQuery(raw, { customMonitoring: true, rql: true });
  return parsed.ok
    ? { query: parsed.query, problem: null }
    : { query: null, problem: parsed.error };
}

/**
 * Why RQL text cannot be an alert, or null: it does not compile, or it can give another shape than
 * one row with one number. The same check runs on the result at each evaluation.
 */
export function sqlAlertProblem(text: string, now: Date): string | null {
  const compiled = compileRql(text, { now });
  if (!compiled.ok) return `${compiled.error.message} Fix: ${compiled.error.fix}`;
  const { columns, oneRow } = compiled;
  if (columns.length !== 1)
    return `An alert compares one number: the query gives ${columns.length} columns. Select one aggregate, for example count(*).`;
  if (!NUMERIC_TYPES.includes(columns[0].type))
    return `An alert compares one number: the column ${columns[0].name} is ${columns[0].type}. Select a number, for example count(*).`;
  if (!oneRow)
    return "An alert compares one number: the query can give many rows. Remove the GROUP BY, and select an aggregate such as count(*) or avg(...).";
  return null;
}
