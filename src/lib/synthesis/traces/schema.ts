import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
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
    // AOBS-3: the canonical representative (the root span) reported status_code = 2:
    // the run's own outcome. Null on a row last written before migration 0041.
    rootError: boolean("root_error"),
    // Whole-trace sums. bigint/numeric(18,6) so a long trace can't overflow.
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    costUsd: numeric("cost_usd", { precision: 18, scale: 6 }).notNull(),
    // RC-505: what the Sessions and Turns filters match on, so a filtered list
    // never scans spans. Distinct values over the whole trace.
    models: text("models").array().notNull().default(sql`'{}'::text[]`),
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    // The canonical representative's service and deployment environment.
    serviceName: text("service_name"),
    environment: text("environment"),
    // The agents and MCP servers of the trace's spans (RC-790): the distinct
    // `agent_key` and `mcp_server` of `otel_spans`, for the Traces filters.
    agents: text("agents").array().notNull().default(sql`'{}'::text[]`),
    mcpServers: text("mcp_servers").array().notNull().default(sql`'{}'::text[]`),
    // The callers' countries (`otel_spans.geo_country`, RC-774), for the Traces country filter.
    countries: text("countries").array().notNull().default(sql`'{}'::text[]`),
    // The callers' harnesses (`otel_spans.harness`, RC-778), for the Traces harness filter.
    harnesses: text("harnesses").array().notNull().default(sql`'{}'::text[]`),
    // The trace's pivot values (RC-884, `FF_PIVOTS`): pivot key to its first
    // non-empty value, root span first. `{}` for a project with no pivots.
    dims: jsonb("dims").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
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
    // The model and tool filters (`models && $1`).
    index("otel_trace_summaries_models_idx").using("gin", t.models),
    index("otel_trace_summaries_tools_idx").using("gin", t.tools),
    // The agent and MCP server filters (`agents && $1`).
    index("otel_trace_summaries_agents_idx").using("gin", t.agents),
    index("otel_trace_summaries_mcp_servers_idx").using("gin", t.mcpServers),
    index("otel_trace_summaries_countries_idx").using("gin", t.countries),
    index("otel_trace_summaries_harnesses_idx").using("gin", t.harnesses),
    // The pivot filter (`dims @> $1`).
    index("otel_trace_summaries_dims_idx").using("gin", sql`${t.dims} jsonb_path_ops`),
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
