import {
  bigint,
  boolean,
  doublePrecision,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** The trace rollups the drain fills from `otel_spans`. Owned fragment of the upstream schema (ADR-0030). */

/**
 * Per-trace silver rollup over `otel_spans`, the trace-grain analogue of
 * `event_metrics` (ADR-0013). Exactly one row per `(project_id, trace_id)`, so
 * the Traces KPI band and volume chart aggregate a table sized by trace count
 * instead of joining every span in the window.
 *
 * Rows are produced by the periodic `refreshTraceSummaries` sweep
 * (`lib/synthesis/traces/summary-refresh.ts`), never on the OTLP ingest path: a trace is
 * fully recomputed whenever any of its spans is newly observed, which makes the
 * sweep idempotent and self-healing. KPIs therefore lag ingestion by up to a
 * sweep interval; the trace list stays live.
 *
 * The representative whose `started_at`/`duration_ms` land here is the
 * **whole-trace** canonical root (`(parent_span_id is null) desc, started_at,
 * span_id`, the rule `selectedTraceRoots` uses), so a summary is
 * window-independent. That diverges from the live earliest-*in-window*-root
 * rollup only for traces straddling a window boundary.
 */
export const otelTraceSummaries = pgTable(
  "otel_trace_summaries",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    traceId: text("trace_id").notNull(),
    // Canonical representative's start: the window filter and UTC-day bucket.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    // Canonical representative's duration; the latency percentiles read this.
    durationMs: doublePrecision("duration_ms").notNull(),
    // Any span in the trace reported status_code = 2.
    hasError: boolean("has_error").notNull(),
    // Whole-trace sums. bigint/numeric(18,6) so a long trace can't overflow.
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    costUsd: numeric("cost_usd", { precision: 18, scale: 6 }).notNull(),
    // Retention key. Span retention prunes by server receipt time, so the
    // summary must expire on the same clock, never on producer `started_at`.
    spansMaxReceivedAt: timestamp("spans_max_received_at", {
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Upsert target for the sweep's full-recompute.
    primaryKey({ columns: [t.projectId, t.traceId] }),
    // The KPI/daily range scan.
    index("otel_trace_summaries_project_started_idx").on(t.projectId, t.startedAt),
    // The retention sweep's bounded batch.
    index("otel_trace_summaries_spans_max_received_idx").on(t.spansMaxReceivedAt),
  ],
);

/**
 * Single-row watermark for the `otel_trace_summaries` sweep: the last
 * `otel_spans` position it has folded in, as the `(received_at, id)` cursor that
 * walks `otel_spans_received_at_idx`.
 *
 * Starting at the epoch makes the sweep its own backfill: the same code drains
 * retained history and then tails ingest, so there is no separate backfill path
 * and no activation cutover to order.
 */
export const traceSummaryCursor = pgTable("trace_summary_cursor", {
  // Constant key; the table holds at most one row.
  id: text("id").primaryKey(),
  // A string, not a Date: a Date keeps milliseconds and `received_at` has microseconds.
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
  // `otel_spans.id`, the received_at tie-break, not a span's OTel span id.
  spanRowId: uuid("span_row_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
