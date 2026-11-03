import { z } from "zod";
import { isGatewayTool } from "@/lib/ingest/gateway-tools";
import { getDailyAggregates, getToolMetrics } from "@/lib/ingest/otlp/queries";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { APP_NAME } from "@/lib/platform/app-config";
import {
  getSpanAggregates,
  getTraceDailyAggregates,
  getTraceFacets,
  getTraceKpis,
  getTraceSpansWithTruncation,
  getTracesIngestDiagnostics,
  listOperations as listTraceOperations,
  listTraces,
} from "@/lib/synthesis/traces/queries";

/**
 * Observability reads.
 *
 * Two sources live in this file and they are not interchangeable, which is the
 * thing most likely to produce a confidently wrong answer here.
 *
 *  - **Spans** (`lib/traces/queries.ts`) carry
 *    per-request detail: latency percentiles, error status, individual traces.
 *  - **Derived event metrics** (`getDailyAggregates`, `getToolMetrics`) carry
 *    token and cost accounting. They are always on, and they are what the
 *    project home page and dashboard render.
 *
 * Both report tokens and cost, computed from different pipelines, so they can
 * disagree. When they do, the event metrics are the number the customer already
 * sees on their own screen, which makes them the one to quote. Every response
 * below therefore names its own `source`, and every description says which
 * questions belong to it and which tool to prefer otherwise. An agent choosing
 * between five overlapping tools by name alone will otherwise pick by vibe.
 *
 * Everything here is summarized on the way out. A trace's raw spans carry full
 * prompt and response payloads: returning them verbatim would hand an agent
 * tens of thousands of tokens to answer a question about latency, which is the
 * exact waste this product measures. Spans are therefore projected down to
 * name, timing, status, and token counts, and `get_trace` caps the count on top
 * of the query's own limit.
 */
const SPAN_CAP = 200;

/**
 * Which pipeline produced the numbers in a response.
 *
 * Carried in the data rather than only in the descriptions because that is
 * where it survives: an agent summarising two results into one answer has the
 * prose long behind it, and two token totals that disagree are indistinguishable
 * once they are bare numbers in a context window.
 */
const SPAN_SOURCE = "spans" as const;
const METRICS_SOURCE = "event_metrics" as const;

export interface ObservabilityOperationDeps {
  listTraces: typeof listTraces;
  getTraceKpis: typeof getTraceKpis;
  getTraceDailyAggregates: typeof getTraceDailyAggregates;
  getTraceFacets: typeof getTraceFacets;
  getSpanAggregates: typeof getSpanAggregates;
  getTraceSpansWithTruncation: typeof getTraceSpansWithTruncation;
  listTraceOperations: typeof listTraceOperations;
  getTracesIngestDiagnostics: typeof getTracesIngestDiagnostics;
  getDailyAggregates: typeof getDailyAggregates;
  getToolMetrics: typeof getToolMetrics;
}

export const defaultObservabilityDeps: ObservabilityOperationDeps = {
  listTraces,
  getTraceKpis,
  getTraceDailyAggregates,
  getTraceFacets,
  getSpanAggregates,
  getTraceSpansWithTruncation,
  listTraceOperations,
  getTracesIngestDiagnostics,
  getDailyAggregates,
  getToolMetrics,
};

/** Filters the trace queries share; kept in one place so they stay consistent. */
const traceFilters = {
  model: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  errorOnly: z.boolean().optional().describe("Only traces containing an error span."),
  experiment: z.string().max(200).optional(),
};

export function observabilityOperations(
  deps: ObservabilityOperationDeps = defaultObservabilityDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "get_trace_health",
      domain: "observability",
      title: "Latency and error rate",
      description:
        "Headline health over a window, from spans: trace count, error rate, p50 and p95 latency, plus token and cost totals. The cheapest answer to how a project is performing. For spend questions prefer get_cost_by_day, which reads the metrics the customer sees on their own dashboard and works even when trace surfaces are off.",
      keywords: ["latency", "p95", "slow", "error rate", "performance", "how fast"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        includeDaily: z
          .boolean()
          .default(false)
          .describe("Also return a per-day series over the window."),
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const [kpis, daily] = await Promise.all([
          deps.getTraceKpis(ctx.projectId, { since: window.since, until: window.until }),
          params.includeDaily
            ? deps.getTraceDailyAggregates(ctx.projectId, {
                since: window.since,
                until: window.until,
              })
            : Promise.resolve(undefined),
        ]);
        return {
          data: {
            source: SPAN_SOURCE,
            kpis: {
              ...kpis,
              errorRate: round(kpis.errorRate),
              averageLatencyMs: round(kpis.averageLatencyMs, 1),
              p50LatencyMs: round(kpis.p50LatencyMs, 1),
              p95LatencyMs: round(kpis.p95LatencyMs, 1),
            },
            ...(daily ? { daily } : {}),
          },
          window: window.toJSON(),
          ...(window.clamped
            ? { hint: "The requested window exceeded the maximum and was clamped." }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "list_traces",
      domain: "observability",
      title: "List traces",
      description:
        "Recent traces with duration, status, span count, token usage and cost. Filter by model, tool, experiment, or errors only. Use get_trace to open one.",
      keywords: ["traces", "requests", "runs", "recent", "browse requests"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        ...traceFilters,
        limit: limitParam,
        includeFacets: z
          .boolean()
          .default(false)
          .describe("Also return the available filter values for this window."),
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.traces);
        const filters = {
          since: window.since,
          until: window.until,
          model: params.model,
          tool: params.tool,
          errorOnly: params.errorOnly,
          experiment: params.experiment,
        };
        const [page, facets] = await Promise.all([
          deps.listTraces(ctx.projectId, { ...filters, limit: params.limit }),
          params.includeFacets
            ? deps.getTraceFacets(ctx.projectId, filters)
            : Promise.resolve(undefined),
        ]);

        return {
          data: {
            count: page.items.length,
            hasMore: page.hasMore,
            traces: page.items.map((trace) => ({
              traceId: trace.traceId,
              rootName: trace.rootName,
              serviceName: trace.serviceName,
              startedAt: trace.startedAt.toISOString(),
              durationMs: round(trace.durationMs, 1),
              statusCode: trace.statusCode,
              spanCount: trace.spanCount,
              errorCount: trace.errorCount,
              totalTokens: trace.totalTokens,
              costUsd: round(trace.costUsd, 6),
              experimentName: trace.experimentName,
              experimentArm: trace.experimentArm,
            })),
            ...(facets ? { facets } : {}),
          },
          truncated: page.hasMore,
          window: window.toJSON(),
          hint: "get_trace opens one trace's span tree. list_span_groups aggregates across traces instead.",
        };
      },
    }),
    defineOperation({
      id: "get_trace",
      domain: "observability",
      title: "Get trace",
      description:
        "The span breakdown for one trace: each span's name, kind, status, duration and token counts. Span payload bodies are deliberately not returned.",
      keywords: ["trace", "one trace", "span tree", "waterfall", "single request"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: z.string().min(1).max(64),
        limit: z.number().int().min(1).max(SPAN_CAP).default(SPAN_CAP),
      }),
      async execute(ctx, params) {
        const load = await deps.getTraceSpansWithTruncation(ctx.projectId, params.traceId);
        if (load.spans.length === 0) throw notFound("trace");

        const tracker = new TruncationTracker();
        tracker.mark(load.truncated);
        const spans = tracker.take(capRows(load.spans, params.limit));

        return {
          data: {
            traceId: params.traceId,
            spanCount: load.spans.length,
            spans: spans.map((span) => ({
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: span.kind,
              statusCode: span.statusCode,
              startedAt: span.startedAt?.toISOString() ?? null,
              durationMs: round(span.durationMs, 1),
              serviceName: span.serviceName,
              inputTokens: span.inputTokens,
              outputTokens: span.outputTokens,
            })),
          },
          truncated: tracker.value,
          hint: `Span attributes and payload bodies are not exposed through MCP. Open the trace in the ${APP_NAME} console to inspect them.`,
        };
      },
    }),
    defineOperation({
      id: "list_span_groups",
      domain: "observability",
      title: "Spans grouped by model, tool or operation",
      description:
        "Span statistics grouped by operation name, model, or tool: call counts, error counts, latency and token usage. The one to reach for when the question is which model or tool dominates, and the only grouped view carrying latency. For per-tool token and cost totals that match the dashboard, prefer get_cost_by_tool.",
      keywords: ["group by model", "which model dominates", "by tool", "by operation", "grouped"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        ...traceFilters,
        groupBy: z.enum(["name", "model", "tool"]).default("name"),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const tracker = new TruncationTracker();
        const rows = await deps.listTraceOperations(ctx.projectId, {
          since: window.since,
          until: window.until,
          groupBy: params.groupBy,
          model: params.model,
          tool: params.tool,
          errorOnly: params.errorOnly,
          experiment: params.experiment,
        });
        const page = tracker.take(capRows(rows, params.limit));
        return {
          data: {
            source: SPAN_SOURCE,
            groupBy: params.groupBy,
            count: page.length,
            total: rows.length,
            operations: page,
          },
          truncated: tracker.value,
          window: window.toJSON(),
        };
      },
    }),
    defineOperation({
      id: "get_span_totals",
      domain: "observability",
      title: "Span totals for a filtered slice",
      description:
        "One row of span totals for a filtered slice: span count, error count, token totals and cost. Use it to size a specific slice (one model, one tool, errors only) rather than to browse. Same source as get_trace_health, so prefer that one for latency percentiles, or get_cost_by_day for spend.",
      keywords: ["totals for a filter", "spans", "sum", "how many spans", "slice"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams, ...traceFilters }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const summary = await deps.getSpanAggregates(ctx.projectId, {
          since: window.since,
          until: window.until,
          model: params.model,
          tool: params.tool,
          errorOnly: params.errorOnly,
          experiment: params.experiment,
        });
        return { data: { source: SPAN_SOURCE, summary }, window: window.toJSON() };
      },
    }),
    defineOperation({
      id: "get_cost_by_day",
      domain: "observability",
      title: "Cost and tokens per day",
      description:
        "Per-day token counts and cost from the derived event metrics, broken down by context source. This is the series the project home page and dashboard render, so it is the number to quote for spend, and it is available whether or not trace surfaces are enabled. Use the span-based tools instead for latency or individual requests.",
      keywords: ["cost", "spend", "budget", "tokens", "per day", "over time", "how much"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const rows = await deps.getDailyAggregates(ctx.projectId, window.since, window.until);
        return {
          data: { source: METRICS_SOURCE, days: rows.length, series: rows },
          window: window.toJSON(),
          ...(window.clamped
            ? { hint: "The requested window exceeded the 90-day maximum and was clamped." }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "get_cost_by_tool",
      domain: "observability",
      title: "Cost and tokens per tool",
      description:
        "Token and call totals per tool over a window, from the derived event metrics, which is the source to quote for per-tool spend. Ratel gateway meta-tools are marked so they are not mistaken for the agent's own. Use list_span_groups grouped by tool instead when you need latency or error counts per tool.",
      keywords: [
        "cost per tool",
        "which tool costs most",
        "per tool",
        "overhead",
        "gateway meta-tools",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams, limit: limitParam }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const tracker = new TruncationTracker();
        const metrics = await deps.getToolMetrics(ctx.projectId, window.since, window.until);
        const entries = Object.entries(metrics ?? {});
        const page = tracker.take(capRows(entries, params.limit));
        return {
          data: {
            source: METRICS_SOURCE,
            count: page.length,
            total: entries.length,
            tools: page.map(([name, value]) => ({
              name,
              isGatewayMetaTool: isGatewayTool(name),
              ...(value as Record<string, unknown>),
            })),
          },
          truncated: tracker.value,
          window: window.toJSON(),
        };
      },
    }),
    defineOperation({
      id: "get_traces_ingest_diagnostics",
      domain: "observability",
      title: "Trace ingest diagnostics",
      description:
        "What the ingest endpoint has actually received for this project, and why spans may have been dropped. The first thing to check when a project appears to have no telemetry.",
      keywords: ["traces not arriving", "ingest", "dropped spans", "no telemetry"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const diagnostics = await deps.getTracesIngestDiagnostics(ctx.projectId);
        return { data: { diagnostics } };
      },
    }),
  ];
}
