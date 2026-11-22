/**
 * The stored event types the intent graph fold learns from. A leaf module so
 * the reader, the cron safety net, the ingest triggers and the schema's drift
 * test all name the same lists without importing each other.
 */
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { traceEvents } from "@/lib/ingest/trace-events/schema";

/**
 * The runtime lane's learning events: the four the core learner consumes
 * (ADR-0014). Never `gateway_search`: it summarizes an inner `search` that is
 * already here, and folding both would double count impressions.
 */
export const FOLD_EVENT_TYPES = ["search", "skill_search", "invoke_start", "skill_invoke"] as const;
export type FoldEventType = (typeof FOLD_EVENT_TYPES)[number];

/**
 * The OTLP lane's: the rows a plain agent trace leaves, which the fold reads
 * as the same pair. The trace's model call carrying the user's ask
 * (`payload.prompt`, present only when the exporter captures content) stands
 * in for the search, and each tool-call span for the invoke. The runtime
 * never searched, so the ask carries no served list and the SDK's `baseline`
 * origin, the one `experimentalBaselineTurn` uses for a turn Ratel did not
 * serve. A customer gets a graph before installing the SDK this way.
 */
export const OTLP_FOLD_EVENT_TYPES = ["otlp_model_call", "invoke_end", "invoke_error"] as const;

/** Which ingest lane a foldable row came from. */
export type FoldLane = "runtime" | "otlp";

/** Whether a stored row is on the OTLP lane: these types from the otlp ingest source only. */
export function isOtlpLaneRow(row: { type: string; ingestSource?: string }): boolean {
  return (
    row.ingestSource === "otlp" && (OTLP_FOLD_EVENT_TYPES as readonly string[]).includes(row.type)
  );
}

/**
 * How far behind `now()` the fold reads. `received_at` is the start of the
 * ingest transaction, not its commit, so a slow batch can commit with a
 * `received_at` older than rows a later batch already committed; a fold that
 * ran in between would advance the cursor past it and never read it, and the
 * cron safety net, asking by the same cursor, would miss it too. Reading only
 * rows older than the longest ingest transaction closes the window; 30
 * seconds is small next to the 60-second hold a search waits for its invoke.
 */
export const FOLD_COMMIT_LAG_MS = 30_000;

/** `received_at` old enough for the fold to read, given the lag above. */
export function foldableReceivedBefore(
  t: Pick<typeof traceEvents, "receivedAt">,
  lagMs: number = FOLD_COMMIT_LAG_MS,
): SQL {
  return sql`${t.receivedAt} < now() - make_interval(secs => ${lagMs / 1000})`;
}

/**
 * The one SQL predicate for "a row the fold reads". The reader pages by it and
 * the cron safety net asks by it whether a project has anything left to fold;
 * written twice, the two drifted once (the safety net counted a model call
 * without a prompt, which the reader skips, so the cursor never passed it and
 * the cron queued an empty fold every minute). The partial index predicate
 * stays type-only, a superset of this, so Postgres still uses it.
 */
export function foldableEventPredicate(
  t: Pick<typeof traceEvents, "type" | "ingestSource" | "payload">,
): SQL {
  const otlp = eq(t.ingestSource, "otlp");
  return or(
    inArray(t.type, [...FOLD_EVENT_TYPES]),
    // The OTLP ask only with the prompt it carries: nothing to learn from without one.
    and(eq(t.type, "otlp_model_call"), otlp, sql`${t.payload} ? 'prompt'`),
    and(inArray(t.type, ["invoke_end", "invoke_error"]), otlp),
  ) as SQL;
}
