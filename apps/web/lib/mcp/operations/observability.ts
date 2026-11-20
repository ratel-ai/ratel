import { z } from "zod";
import { isGatewayTool } from "@/lib/ingest/gateway-tools";
import { getDailyAggregates, getToolMetrics } from "@/lib/ingest/otlp/queries";
import { notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { projectScoped } from "@/lib/mcp/operations/params";
import {
  contentFreeTitle,
  cursorParam,
  encodePageCursor,
  recordSortParams,
  requireCursor,
  resolvePagedWindow,
  resolveRunListQuery,
  runFilterParams,
  spanFacetParams,
  spanFacts,
  traceFilters,
  traceIdParam,
} from "@/lib/mcp/operations/runs";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { getLogger } from "@/lib/platform/logger";
import {
  getSpanAggregates,
  getTraceDailyAggregates,
  getTraceFacets,
  getTraceKpis,
  getTraceSpansWithTruncation,
  getTracesIngestDiagnostics,
  listOperations as listTraceOperations,
  listTraces,
  type TraceFacets,
} from "@/lib/synthesis/traces/queries";
import { listRunAsks, listRunTools } from "@/lib/synthesis/traces/run-details";
import { runStatus } from "@/lib/synthesis/traces/v2/runs";
import { parseTraceCursor, serializeTraceCursor } from "@/lib/synthesis/traces/view";
import { loadTraceViewProps } from "@/lib/views/traces/trace-view-props";
import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";
import { withoutCapturedText } from "@/lib/views/traces/without-captured-text";

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
 * name, timing, status, tokens and the few facts the step inspector shows, and
 * `get_trace` caps the count on top of the query's own limit. The payloads are
 * one call further away, previewed, in `runs.ts` (`get_span`,
 * `get_trace_conversation`). A run's ask and a search's words are captured
 * text, returned only to a caller that may read it (`mayReadContent`).
 */
const SPAN_CAP = 200;

/** The Runs list keeps this much of an ask; get_run_summary has a longer preview. */
const RUN_ASK_CHARS = 240;
const RUN_TOOL_CAP = 15;
/** Facet values per dimension; the query itself allows up to 50. */
const FACET_VALUE_CAP = 20;

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

export interface ObservabilityOperationDeps extends ContentAccessDeps {
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
  listRunTools: typeof listRunTools;
  listRunAsks: typeof listRunAsks;
  /**
   * The console trace page's TraceView props (lib/traces/v2/trace-view-props.ts),
   * for get_trace's view; null when the read fails (the call answers without them).
   */
  loadTraceViewProps: (projectId: string, traceId: string) => Promise<TraceViewProps | null>;
}

const logger = getLogger("mcp/observability");

async function readTraceViewProps(
  projectId: string,
  traceId: string,
): Promise<TraceViewProps | null> {
  const tracesPath = `/project/${encodeURIComponent(projectId)}/traces`;
  try {
    return await loadTraceViewProps(projectId, traceId, {
      listHref: tracesPath,
      compareHref: `${tracesPath}?compare=${encodeURIComponent(traceId)}`,
      tab: undefined,
      spanId: null,
    });
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "trace view props failed; the view gets the trace without them",
    );
    return null;
  }
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
  listRunTools,
  listRunAsks,
  loadTraceViewProps: readTraceViewProps,
  contentOptIn: readContentOptIn,
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
        "Runs (traces) as the Runs page lists them: duration, status, spans, tokens, cost, variant. Filter by name, model, tool, experiment, variant, status, service, environment or duration, token and cost ranges; sort and page with cursor. includeDetails adds each run's ask and tools. get_run_summary opens one; get_run_stats totals the same filters.",
      keywords: [
        "traces",
        "requests",
        "runs",
        "recent",
        "browse requests",
        "slowest runs",
        "failed runs",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        ...traceFilters,
        ...runFilterParams,
        ...spanFacetParams,
        ...recordSortParams,
        cursor: cursorParam,
        limit: limitParam,
        includeFacets: z
          .boolean()
          .default(false)
          .describe("Also return the available filter values for this window."),
        includeDetails: z
          .boolean()
          .default(false)
          .describe(
            "Also return each run's ask (when content is captured), tools called, and status.",
          ),
      }),
      async execute(ctx, params) {
        const { window, token } = resolvePagedWindow(params, WINDOW_PRESETS.traces);
        const query = resolveRunListQuery(ctx.projectId, params, window);
        const cursor = requireCursor(token, (raw) => parseTraceCursor(raw, query.filters));
        const [page, facets] = await Promise.all([
          deps.listTraces(ctx.projectId, {
            ...query.queryOptions,
            ...(cursor ? { cursor } : {}),
            limit: params.limit,
          }),
          params.includeFacets
            ? deps.getTraceFacets(ctx.projectId, query.facetOptions)
            : Promise.resolve(undefined),
        ]);

        // The Runs page's two extra columns, read for this page's runs only.
        const traceIds = page.items.map((trace) => trace.traceId);
        const details = params.includeDetails && traceIds.length > 0;
        const content = details ? await mayReadContent(ctx, deps) : true;
        const [tools, asks] = details
          ? await Promise.all([
              deps.listRunTools(ctx.projectId, traceIds),
              deps.listRunAsks(ctx.projectId, traceIds),
            ])
          : [undefined, undefined];

        const tracker = new TruncationTracker();
        tracker.mark(page.hasMore);
        const runDetails = (traceId: string, statusCode: number, errorCount: number) => {
          if (!params.includeDetails) return {};
          const ask = asks?.get(traceId);
          return {
            status: runStatus(statusCode, errorCount, ask?.hasRoot ?? true),
            ask: content && ask?.prompt ? tracker.text(ask.prompt, RUN_ASK_CHARS) : null,
            tools: tracker.take(capRows(tools?.get(traceId) ?? [], RUN_TOOL_CAP)),
          };
        };

        return {
          data: {
            count: page.items.length,
            hasMore: page.hasMore,
            nextCursor:
              page.hasMore && page.nextCursor
                ? encodePageCursor(window, serializeTraceCursor(page.nextCursor, query.filters))
                : null,
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
              ...runDetails(trace.traceId, trace.statusCode, trace.errorCount),
            })),
            ...(facets ? { facets: capFacets(facets, tracker) } : {}),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: contentHint(
            content,
            page.hasMore
              ? "Pass nextCursor as cursor, with the same filters, for the next page. get_run_summary opens one run."
              : "get_run_summary tells one run as a conversation; get_trace lists its spans. list_span_groups aggregates across runs.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_trace",
      domain: "observability",
      title: "Get trace",
      description:
        "The span breakdown for one trace: each span's name, kind, status, duration, tokens, and where they apply its step kind, model, tool, cost, error type and search. Payload bodies are not returned: get_span opens one span in full, get_trace_conversation shows the messages.",
      keywords: ["trace", "one trace", "span tree", "waterfall", "single request", "timeline"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: traceIdParam,
        limit: z.number().int().min(1).max(SPAN_CAP).default(SPAN_CAP),
      }),
      async execute(ctx, params) {
        // Ingest stores ids lowercase; the console lowercases a pasted id too.
        const traceId = params.traceId.trim().toLowerCase();
        const load = await deps.getTraceSpansWithTruncation(ctx.projectId, traceId);
        if (load.spans.length === 0) throw notFound("trace");
        const content = await mayReadContent(ctx, deps);

        const tracker = new TruncationTracker();
        tracker.mark(load.truncated);
        const spans = tracker.take(capRows(load.spans, params.limit));
        // The view renders the console's TraceView from the trace page's own props, text withheld as here.
        const props = ctx.forView ? await deps.loadTraceViewProps(ctx.projectId, traceId) : null;
        const root = load.spans.find((span) => span.parentSpanId === null) ?? load.spans[0]!;

        return {
          ...(props
            ? {
                view: {
                  kind: "trace",
                  props: content ? props : withoutCapturedText(props, contentFreeTitle(root)),
                },
              }
            : {}),
          data: {
            traceId,
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
              ...spanFacts(span, tracker, content),
            })),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: content
            ? "get_span opens one span with its attributes and tool payloads; get_run_summary tells the run as a conversation; get_trace_conversation shows its messages; get_trace_ranking lists its experiment records."
            : contentHint(
                false,
                "Search queries are left out here. get_span opens one span's timing, model, tokens, status and error type, without its attributes or tool payloads; get_run_summary lists the run's steps; get_trace_ranking lists its experiment records.",
              ),
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
        "Whether this project has received any agent events or OTel spans, and when the latest of each arrived. Answers whether a project that looks empty has received data at all. For why SDK events were refused or dropped, call list_sdk_events with view rejects or drops.",
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

/** Facet values capped per dimension, most frequent first as the query ranks them. */
function capFacets(facets: TraceFacets, tracker: TruncationTracker): TraceFacets {
  return Object.fromEntries(
    Object.entries(facets).map(([key, values]) => [
      key,
      tracker.take(capRows(values, FACET_VALUE_CAP)),
    ]),
  ) as TraceFacets;
}
