import { z } from "zod";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { invalidParams, notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  experimentAttributesFor,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import {
  type ResolvedWindow,
  resolveWindow,
  WINDOW_PRESETS,
  type WindowBounds,
  windowParams,
} from "@/lib/mcp/windows";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { summarizeTraceForComparison } from "@/lib/synthesis/traces/comparison";
import { buildTraceContentView, preferSpanContent } from "@/lib/synthesis/traces/content-view";
import {
  type ListProjectEventsOptions,
  listProjectEvents,
  type ProjectEventPage,
} from "@/lib/synthesis/traces/events-queries";
import {
  parseEventCursor,
  resolveEventListView,
  serializeEventCursor,
} from "@/lib/synthesis/traces/events-view";
import {
  formatAttributeValue,
  formatSpanKind,
  formatSpanStatus,
} from "@/lib/synthesis/traces/format";
import {
  loadPayloadContentSafely,
  type PayloadContent,
} from "@/lib/synthesis/traces/payload-content";
import {
  getTraceAggregates,
  getTraceSpansWithTruncation,
  type ListSpansOptions,
  type ListTracesOptions,
  listSpans,
  listTraceLifecycleEvents,
  type SpanPage,
  type TraceAggregateSummary,
  type TraceLifecycleEvent,
  type TraceSpanLoad,
  type TraceVolumeOptions,
  type TraceWindow,
} from "@/lib/synthesis/traces/queries";
import { conversationMessages } from "@/lib/synthesis/traces/v2/conversation";
import { logPresentation, salientAttributes } from "@/lib/synthesis/traces/v2/logs";
import { buildRunSummary, MAX_SUMMARY_STEPS } from "@/lib/synthesis/traces/v2/run-summary";
import {
  STEP_KIND_LABEL,
  stepKind,
  stepTitle,
  stringAttribute,
  toolNameFromSpanName,
} from "@/lib/synthesis/traces/v2/span-kind";
import {
  parseSpanCursor,
  resolveSpanListView,
  resolveTraceCompareIds,
  resolveTraceListView,
  serializeSpanCursor,
  type TraceListFilters,
  type TraceListSearchParams,
} from "@/lib/synthesis/traces/view";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import { agentHealthEnabled } from "@/lib/views/health/agent-health-flag";
import { loadTurnDetail, type TurnDetail } from "@/lib/views/traces/turn-detail";

/**
 * Runs and traces, one tool per thing the Traces section shows: a run told as
 * a conversation, one span in full, the Conversation and Ranking tabs, the
 * Spans and Logs lists, a side-by-side comparison, and one Agent health turn.
 * `list_traces` and `get_trace` (observability.ts) are the entry points; this
 * file is where an agent goes once it has a trace id.
 *
 * Every read goes through the same `lib/traces` function and the same view
 * resolver its console page uses, so a filter means the same thing here as in
 * the URL, and a cursor is the page's own cursor. The pages bound each read
 * with a statement timeout, and the default deps do the same: dispatch turns a
 * cancelled statement into an actionable `timeout` rather than a 500.
 *
 * Span attributes and message content are the customer's own data, shown to
 * any member on the trace page, so they are returned to a signed-in member,
 * and to an API key only with the project's content opt-in (`mayReadContent`).
 * They are also the bulkiest thing in the product, so every value is cut to a
 * preview and every list is capped, with `truncated` set whenever anything was
 * dropped.
 */

/** Attributes `get_span` lists before pointing at `attributePrefix`. */
const SPAN_ATTRIBUTE_CAP = 60;
const ATTRIBUTE_VALUE_CHARS = 500;
const TOOL_PAYLOAD_CHARS = 1_000;
const STEP_TITLE_CHARS = 200;
const MESSAGE_CHARS = 1_500;
const TOOL_CALL_CAP = 25;
const LOG_ATTRIBUTE_CAP = 20;
const LOG_VALUE_CHARS = 200;
const RANKING_ATTRIBUTE_CAP = 12;
/** Hourly volume beyond a week is more rows than an answer needs. */
const HOURLY_VOLUME_MAX_DAYS = 7;
const DAY_MS = 86_400_000;

const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;
type SpanStatusName = keyof typeof SPAN_STATUS;

const CURSOR_MISMATCH =
  "`cursor` belongs to a different query. Pass the same filters, sort and window as the call that returned it, or drop it to start from the first page.";

export interface RunsOperationDeps extends ContentAccessDeps {
  getTraceSpansWithTruncation: (projectId: string, traceId: string) => Promise<TraceSpanLoad>;
  listTraceLifecycleEvents: (projectId: string, traceId: string) => Promise<TraceLifecycleEvent[]>;
  listSpans: (projectId: string, options: ListSpansOptions) => Promise<SpanPage>;
  listProjectEvents: (
    projectId: string,
    options: ListProjectEventsOptions,
  ) => Promise<ProjectEventPage>;
  getTraceAggregates: (
    projectId: string,
    options: ListTracesOptions & TraceWindow & TraceVolumeOptions,
  ) => Promise<TraceAggregateSummary>;
  loadTurnDetail: (projectId: string, turnId: string) => Promise<TurnDetail | null>;
  /** The turn page's gate. Retired to always-on, kept so the two cannot drift. */
  agentHealthEnabled: (projectId: string, organizationId: string | null) => Promise<boolean>;
  /** The trace's `events.payload` content, as the pages read it; null when nothing is stored or the read fails. */
  loadPayloadContent: (projectId: string, traceId: string) => Promise<PayloadContent | null>;
}

export const defaultRunsDeps: RunsOperationDeps = {
  getTraceSpansWithTruncation: (projectId, traceId) =>
    withStatementTimeout((db) => getTraceSpansWithTruncation(projectId, traceId, db), {
      operation: "mcp_trace_detail",
    }),
  listTraceLifecycleEvents: (projectId, traceId) =>
    withStatementTimeout((db) => listTraceLifecycleEvents(projectId, traceId, db), {
      operation: "mcp_trace_lifecycle",
    }),
  listSpans: (projectId, options) =>
    withStatementTimeout((db) => listSpans(projectId, options, db), {
      operation: "mcp_trace_spans",
    }),
  listProjectEvents: (projectId, options) =>
    withStatementTimeout((db) => listProjectEvents(projectId, options, db), {
      operation: "mcp_trace_events",
    }),
  getTraceAggregates: (projectId, options) =>
    withStatementTimeout((db) => getTraceAggregates(projectId, options, db), {
      operation: "mcp_trace_filtered_aggregates",
    }),
  loadTurnDetail: (projectId, turnId) =>
    withStatementTimeout((db) => loadTurnDetail(projectId, turnId, db), {
      operation: "mcp_trace_turn_detail",
    }),
  agentHealthEnabled: (projectId, organizationId) => agentHealthEnabled(projectId, organizationId),
  loadPayloadContent: (projectId, traceId) =>
    loadPayloadContentSafely(projectId, traceId, "mcp_trace_payload"),
  contentOptIn: readContentOptIn,
};

// ---------------------------------------------------------------------------
// Shared parameters and query building (also used by list_traces).
// ---------------------------------------------------------------------------

/** Filters the trace queries share; kept in one place so they stay consistent. */
export const traceFilters = {
  model: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  errorOnly: z.boolean().optional().describe("Only traces containing an error span."),
  experiment: z.string().max(200).optional(),
};

/** The Runs page's own text filters, beyond `traceFilters`. */
export const runFilterParams = {
  rootName: z
    .string()
    .max(200)
    .optional()
    .describe("Run (top-level span) name contains this text."),
  spanName: z
    .string()
    .max(200)
    .optional()
    .describe("Keep runs with a span whose name contains this text."),
  arm: z.string().max(200).optional().describe("Experiment variant (arm) contains this text."),
};

/**
 * The page's "Add filter" facets. They match individual spans: on a run list a
 * run is kept when at least one of its spans matches all of them.
 */
export const spanFacetParams = {
  status: z
    .array(z.enum(["unset", "ok", "error"]))
    .max(3)
    .optional()
    .describe("Span status, any of."),
  service: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe("Exact service names, any of."),
  environment: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe("Exact deployment environments, any of."),
  minDurationMs: z.number().min(0).optional().describe("Span duration at least this, in ms."),
  maxDurationMs: z.number().min(0).optional(),
  minTokens: z
    .number()
    .min(0)
    .optional()
    .describe("Span tokens (input plus output) at least this."),
  maxTokens: z.number().min(0).optional(),
  minCostUsd: z.number().min(0).optional().describe("Span cost at least this, in USD."),
  maxCostUsd: z.number().min(0).optional(),
};

export const recordSortParams = {
  sort: z.enum(["started", "duration", "tokens", "cost"]).default("started"),
  direction: z.enum(["asc", "desc"]).default("desc"),
};

export const cursorParam = z
  .string()
  .min(1)
  .max(4_000)
  .optional()
  .describe(
    "nextCursor from the previous call. Keep every other parameter the same; it carries the window.",
  );

type SpanFacetInput = {
  status?: readonly SpanStatusName[];
  service?: readonly string[];
  environment?: readonly string[];
  minDurationMs?: number;
  maxDurationMs?: number;
  minTokens?: number;
  maxTokens?: number;
  minCostUsd?: number;
  maxCostUsd?: number;
};

export type RunListInput = SpanFacetInput & {
  rootName?: string;
  spanName?: string;
  model?: string;
  tool?: string;
  errorOnly?: boolean;
  experiment?: string;
  arm?: string;
  sort?: "started" | "duration" | "tokens" | "cost";
  direction?: "asc" | "desc";
};

/** The facet filters as the page's URL carries them, for its own resolver. */
function facetSearch(input: SpanFacetInput): TraceListSearchParams {
  const text = (value: number | undefined) => (value === undefined ? undefined : String(value));
  return {
    facetStatus: input.status?.map((status) => String(SPAN_STATUS[status])),
    facetService: input.service,
    facetEnvironment: input.environment,
    minDurationMs: text(input.minDurationMs),
    maxDurationMs: text(input.maxDurationMs),
    minTokens: text(input.minTokens),
    maxTokens: text(input.maxTokens),
    minCostUsd: text(input.minCostUsd),
    maxCostUsd: text(input.maxCostUsd),
  };
}

/**
 * The page's day-granular range swapped for the MCP window. `from`/`to` are
 * part of the cursor's context, so they hold the exact window bounds: a cursor
 * only parses against the window it was issued for.
 */
function windowOverride(window: ResolvedWindow) {
  const { since, until } = window.toJSON();
  return {
    filters: { range: "custom" as const, from: since, to: until },
    query: { since: window.since, until: window.until },
  };
}

/**
 * The Runs page's query for these filters: `resolveTraceListView` normalizes
 * them exactly as the URL would, and the facets use the span view, as the page
 * does.
 */
export function resolveRunListQuery(
  projectId: string,
  input: RunListInput,
  window: ResolvedWindow,
) {
  const search: TraceListSearchParams = {
    project: projectId,
    rootName: input.rootName,
    name: input.spanName,
    model: input.model,
    tool: input.tool,
    errorOnly: input.errorOnly ? "1" : undefined,
    experiment: input.experiment,
    arm: input.arm,
    sort: input.sort,
    direction: input.direction,
    ...facetSearch(input),
  };
  const view = resolveTraceListView(search);
  const spanView = resolveSpanListView(search);
  const bounds = windowOverride(window);
  const filters: TraceListFilters = { ...view.filters, ...bounds.filters };
  return {
    filters,
    queryOptions: { ...view.queryOptions, ...bounds.query } satisfies ListTracesOptions,
    facetOptions: { ...spanView.queryOptions, ...bounds.query } satisfies ListSpansOptions,
  };
}

/**
 * The page cursors are relative to the page's filters, and MCP's `until`
 * defaults to "now", which moves between calls. So a cursor handed out here
 * carries the window it was issued for alongside the page's own token, and the
 * next call reruns over that exact window.
 */
export function encodePageCursor(window: ResolvedWindow, token: string): string {
  const { since, until } = window.toJSON();
  return Buffer.from(JSON.stringify([since, until, token]), "utf8").toString("base64url");
}

export function resolvePagedWindow(
  params: { since?: string; until?: string; cursor?: string },
  bounds: WindowBounds,
): { window: ResolvedWindow; token: string | undefined } {
  if (!params.cursor) return { window: resolveWindow(params, bounds), token: undefined };
  const decoded = decodePageCursor(params.cursor);
  const differs = (requested: string | undefined, carried: string) =>
    requested !== undefined && Date.parse(requested) !== Date.parse(carried);
  if (differs(params.since, decoded.since) || differs(params.until, decoded.until)) {
    throw invalidParams(CURSOR_MISMATCH);
  }
  return {
    window: resolveWindow({ since: decoded.since, until: decoded.until }, bounds),
    token: decoded.token,
  };
}

/** A page token parsed against this call's filters, or a clear refusal. */
export function requireCursor<T>(
  token: string | undefined,
  parse: (token: string) => T | undefined,
): T | undefined {
  if (token === undefined) return undefined;
  const cursor = parse(token);
  if (!cursor) throw invalidParams(CURSOR_MISMATCH);
  return cursor;
}

function decodePageCursor(raw: string): { since: string; until: string; token: string } {
  try {
    const payload: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(payload) &&
      payload.length === 3 &&
      payload.every((part) => typeof part === "string")
    ) {
      return { since: payload[0], until: payload[1], token: payload[2] };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw invalidParams(
    "`cursor` is not one this tool returned. Drop it to start from the first page.",
  );
}

// ---------------------------------------------------------------------------
// Span shaping (also used by get_trace).
// ---------------------------------------------------------------------------

export const traceIdParam = z
  .string()
  .min(1)
  .max(64)
  .describe("The 32-character hex trace id, as list_traces returns it.");

/** Ingest stores trace ids lowercase; a malformed id reads as missing, as on the page. */
function normalizeTraceId(raw: string, entity = "trace"): string {
  const id = raw.trim().toLowerCase();
  if (!TRACE_ID.test(id)) throw notFound(entity);
  return id;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The tool a span called: its declared name, else the cleaned span name. */
function spanToolName(span: Pick<OtelSpan, "name" | "spanClass" | "attributes">): string | null {
  if (span.spanClass !== "tool") return null;
  return stringAttribute(span.attributes, "gen_ai.tool.name") ?? toolNameFromSpanName(span.name);
}

/**
 * What the step inspector shows beside the timeline, minus payloads: the kind
 * of step, its model or tool, cost, the error type when it failed, and the
 * search it ran. Fields that do not apply are omitted rather than sent as null,
 * and the search's text only when the caller may read captured text.
 */
export function spanFacts(span: OtelSpan, tracker: TruncationTracker, content: boolean) {
  const failed = span.statusCode === 2;
  const tool = spanToolName(span);
  const cost = toNumber(span.costUsd);
  const errorType = failed ? stringAttribute(span.attributes, "error.type") : null;
  return {
    step: stepKind(span),
    ...(span.model ? { model: span.model } : {}),
    ...(tool ? { toolName: tool } : {}),
    ...(cost !== null && cost > 0 ? { costUsd: round(cost, 6) } : {}),
    ...(errorType ? { errorType } : {}),
    ...(content && span.searchQuery
      ? { searchQuery: tracker.text(span.searchQuery, STEP_TITLE_CHARS) }
      : {}),
    ...(span.searchHitCount !== null ? { searchHitCount: span.searchHitCount } : {}),
  };
}

/** A step's title without captured text: a search reads as its target, not its query. */
export function contentFreeTitle(span: OtelSpan): string {
  return stepTitle({ ...span, searchQuery: null });
}

/** Attributes in the Details tab's order (codepoint), each value previewed. */
function previewAttributes(
  attributes: Readonly<Record<string, unknown>>,
  options: { cap: number; chars: number; skip?: ReadonlySet<string>; prefix?: string },
  tracker: TruncationTracker,
): { total: number; attributes: Record<string, string> } {
  const entries = Object.entries(attributes)
    .filter(
      ([key]) => !options.skip?.has(key) && (!options.prefix || key.startsWith(options.prefix)),
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const kept = tracker.take(capRows(entries, options.cap));
  return {
    total: entries.length,
    attributes: Object.fromEntries(
      kept.map(([key, value]) => [key, tracker.text(formatAttributeValue(value), options.chars)]),
    ),
  };
}

const TOOL_ARGUMENTS = "gen_ai.tool.call.arguments";
const TOOL_RESULT = "gen_ai.tool.call.result";
const TOOL_PAYLOAD_KEYS: ReadonlySet<string> = new Set([TOOL_ARGUMENTS, TOOL_RESULT]);

export function runsOperations(deps: RunsOperationDeps = defaultRunsDeps): McpOperation[] {
  const loadTrace = async (projectId: string, rawTraceId: string, entity = "trace") => {
    const traceId = normalizeTraceId(rawTraceId, entity);
    const load = await deps.getTraceSpansWithTruncation(projectId, traceId);
    if (load.spans.length === 0) throw notFound(entity);
    return { traceId, load };
  };

  return [
    defineOperation({
      id: "get_run_summary",
      domain: "observability",
      title: "Run as a conversation",
      description:
        "One run told as a conversation, as the run panel shows it: the ask, the answer, each model call, tool call and search in order with its timing, the run's error, and totals for duration, tokens and cost. The best first read of a run. get_span opens a step by its id; get_trace_conversation has the full messages.",
      keywords: ["run", "what happened", "conversation", "steps", "ask", "answer", "run summary"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: traceIdParam,
        maxSteps: z
          .number()
          .int()
          .min(1)
          .max(MAX_SUMMARY_STEPS)
          .default(50)
          .describe(`Steps to list (max ${MAX_SUMMARY_STEPS}).`),
      }),
      async execute(ctx, params) {
        const { traceId, load } = await loadTrace(ctx.projectId, params.traceId, "run");
        const payload = await deps.loadPayloadContent(ctx.projectId, traceId);
        const summary = buildRunSummary(load.spans, params.maxSteps, payload);
        const content = await mayReadContent(ctx, deps);
        const tracker = new TruncationTracker();
        tracker.mark(load.truncated || summary.hiddenStepCount > 0);
        // Withheld, the run's title is its root step's (not the ask) and a search reads as its target.
        const spansById = new Map(load.spans.map((span) => [span.spanId, span]));
        const titleOf = (spanId: string, title: string) => {
          const span = content ? undefined : spansById.get(spanId);
          return span ? contentFreeTitle(span) : title;
        };
        const rootSpan = load.spans.find((span) => span.parentSpanId === null) ?? load.spans[0];

        return {
          data: {
            traceId,
            status: summary.status,
            startedAt: summary.startedAt,
            title: tracker.text(
              content ? summary.title : contentFreeTitle(rootSpan),
              STEP_TITLE_CHARS,
            ),
            ask: content ? summary.ask : null,
            answer: content ? summary.answer : null,
            contentCaptured: summary.contentCaptured,
            ...withheldMarker(content),
            runError: summary.runError,
            totals: { ...summary.totals, costUsd: round(summary.totals.costUsd, 6) },
            steps: summary.steps.map((step) => ({
              spanId: step.id,
              kind: step.kind,
              label: step.label,
              title: tracker.text(titleOf(step.id, step.title), STEP_TITLE_CHARS),
              detail: step.detail,
              offsetMs: round(step.offsetMs, 1),
              durationMs: round(step.durationMs, 1),
              failed: step.failed,
              ...(step.errorType ? { errorType: step.errorType } : {}),
            })),
            hiddenStepCount: summary.hiddenStepCount,
            spansTruncated: load.truncated,
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            summary.contentCaptured
              ? content
                ? "The ask and answer are previews: get_trace_conversation has them in full. get_span opens one step by its spanId."
                : "get_span opens one step by its spanId."
              : "This project does not capture message content, so there is no ask or answer. get_span opens one step by its spanId.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_span",
      domain: "observability",
      title: "Get span",
      description:
        "One span in full, as the step inspector and Details tab show it: identity, timing, status, model, tokens, cost, search query and hits, error type, tool arguments and result, and its attributes and experiment attributes, each value previewed. Use get_trace to find span ids.",
      keywords: [
        "span",
        "attributes",
        "step detail",
        "tool arguments",
        "tool result",
        "error type",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: traceIdParam,
        spanId: z
          .string()
          .min(1)
          .max(64)
          .describe("The span id, from get_trace or get_run_summary."),
        attributePrefix: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only attributes whose key starts with this, e.g. gen_ai. or ratel."),
      }),
      async execute(ctx, params) {
        const { traceId, load } = await loadTrace(ctx.projectId, params.traceId);
        const span = load.spans.find((candidate) => candidate.spanId === params.spanId.trim());
        if (!span) throw notFound("span");
        const content = await mayReadContent(ctx, deps);

        const tracker = new TruncationTracker();
        // Attributes carry prompts, messages and tool payloads: none of them without content access.
        const payload = (key: string) =>
          !content || span.attributes[key] === undefined
            ? undefined
            : tracker.text(formatAttributeValue(span.attributes[key]), TOOL_PAYLOAD_CHARS);
        const toolArguments = payload(TOOL_ARGUMENTS);
        const toolResult = payload(TOOL_RESULT);
        const attributes = previewAttributes(
          content ? span.attributes : {},
          {
            cap: SPAN_ATTRIBUTE_CAP,
            chars: ATTRIBUTE_VALUE_CHARS,
            skip: TOOL_PAYLOAD_KEYS,
            prefix: params.attributePrefix,
          },
          tracker,
        );
        const attributeTotal = content ? attributes.total : Object.keys(span.attributes).length;
        const experimentAttributes = previewAttributes(
          experimentAttributesFor(span.experimentAttrs, content),
          { cap: SPAN_ATTRIBUTE_CAP, chars: ATTRIBUTE_VALUE_CHARS },
          tracker,
        );

        return {
          data: {
            traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            label: STEP_KIND_LABEL[stepKind(span)],
            title: tracker.text(
              content ? stepTitle(span) : contentFreeTitle(span),
              STEP_TITLE_CHARS,
            ),
            kind: formatSpanKind(span.kind),
            status: formatSpanStatus(span.statusCode),
            startedAt: span.startedAt.toISOString(),
            durationMs: round(span.durationMs, 1),
            operationName: span.operationName,
            providerName: span.providerName,
            serviceName: span.serviceName,
            scopeName: span.scopeName,
            inputTokens: span.inputTokens,
            outputTokens: span.outputTokens,
            cachedTokens: span.cachedTokens,
            reasoningTokens: span.reasoningTokens,
            ...spanFacts(span, tracker, content),
            ...(span.searchTarget ? { searchTarget: span.searchTarget } : {}),
            experimentName: span.experimentName,
            experimentArm: span.experimentArm,
            experimentRole: span.experimentRole,
            ...(toolArguments !== undefined ? { toolArguments } : {}),
            ...(toolResult !== undefined ? { toolResult } : {}),
            attributeCount: attributeTotal,
            attributes: content ? attributes.attributes : null,
            attributesCutAtIngest: span.attrsTruncated,
            experimentAttributes: experimentAttributes.attributes,
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            !content
              ? "get_trace lists the other spans."
              : attributes.total > SPAN_ATTRIBUTE_CAP
                ? `Only the first ${SPAN_ATTRIBUTE_CAP} attributes are listed; pass attributePrefix to read a subset. get_trace_conversation shows the messages.`
                : "get_trace_conversation shows the run's messages; get_trace lists the other spans.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_trace_conversation",
      domain: "observability",
      title: "Trace conversation",
      description:
        "The Conversation tab of one trace: the system, user, assistant and tool messages in order, each once, and the tool calls with their arguments and results. Needs message content capture; without it the list is empty and get_run_summary still shows the steps. Page long conversations with offset.",
      keywords: [
        "conversation",
        "messages",
        "prompt",
        "response",
        "what did the agent say",
        "transcript",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: traceIdParam,
        offset: z.number().int().min(0).default(0).describe("Messages to skip, for the next page."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(40)
          .describe("Messages to return (max 100)."),
        maxChars: z
          .number()
          .int()
          .min(200)
          .max(4_000)
          .default(MESSAGE_CHARS)
          .describe("Characters kept per message."),
        includeToolCalls: z.boolean().default(true),
      }),
      async execute(ctx, params) {
        const { traceId, load } = await loadTrace(ctx.projectId, params.traceId);
        // The tab reads the spans in timeline order, so this does too.
        const ordered = buildTraceWaterfall(load.spans).rows.map((row) => row.span);
        const payload = await deps.loadPayloadContent(ctx.projectId, traceId);
        const content = preferSpanContent(buildTraceContentView(ordered), payload?.view ?? null);
        const messages = conversationMessages(content.messages);
        const readable = await mayReadContent(ctx, deps);

        const tracker = new TruncationTracker();
        tracker.mark(load.truncated);
        // Withheld, the counts and tool call facts stay; no message text, arguments or results.
        const window = readable ? messages.slice(params.offset, params.offset + params.limit) : [];
        const remaining = readable
          ? Math.max(0, messages.length - params.offset - window.length)
          : 0;
        tracker.mark(remaining > 0);
        const toolCalls = params.includeToolCalls
          ? tracker.take(capRows(content.toolCalls, TOOL_CALL_CAP))
          : [];

        return {
          data: {
            traceId,
            contentCaptured: content.contentCaptured,
            messageCount: messages.length,
            offset: params.offset,
            messages: window.map((message) => ({
              role: message.role,
              text: tracker.text(message.text, params.maxChars),
              chars: message.text.length,
            })),
            toolCallCount: content.toolCalls.length,
            toolCalls: toolCalls.map((call) => ({
              name: call.name,
              spanId: call.spanId,
              durationMs: round(call.durationMs, 1),
              failed: call.statusCode === 2,
              arguments:
                !readable || call.arguments === null
                  ? null
                  : tracker.text(formatAttributeValue(call.arguments), ATTRIBUTE_VALUE_CHARS),
              result:
                !readable || call.result === null
                  ? null
                  : tracker.text(formatAttributeValue(call.result), ATTRIBUTE_VALUE_CHARS),
            })),
            ...withheldMarker(readable),
          },
          truncated: tracker.value,
          hint: contentHint(
            readable,
            !content.contentCaptured
              ? "This trace carries no message content (capture is off). get_run_summary lists its steps; get_span opens one."
              : !readable
                ? "get_run_summary lists the run's steps."
                : remaining > 0
                  ? `${remaining} more messages: call again with offset ${params.offset + window.length}.`
                  : "get_span opens a tool call's span by its spanId.",
          ),
        };
      },
    }),
    defineOperation({
      id: "list_spans",
      domain: "observability",
      title: "List spans",
      description:
        "Individual spans across runs, as the Spans page lists them: name, step kind, model, tool, duration, status, tokens and cost. All spans or top-level only, the same filters and sorts as list_traces, paged by cursor. For totals per model or tool use list_span_groups; get_span opens one.",
      keywords: ["spans", "slowest calls", "every model call", "tool calls", "span list"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        scope: z.enum(["all", "root"]).default("all").describe("root lists top-level spans only."),
        name: z.string().max(200).optional().describe("Span name contains this text."),
        ...traceFilters,
        errorOnly: z.boolean().optional().describe("Only spans with error status."),
        arm: runFilterParams.arm,
        ...spanFacetParams,
        ...recordSortParams,
        cursor: cursorParam,
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const { window, token } = resolvePagedWindow(params, WINDOW_PRESETS.traces);
        const view = resolveSpanListView({
          project: ctx.projectId,
          scope: params.scope,
          name: params.name,
          model: params.model,
          tool: params.tool,
          experiment: params.experiment,
          arm: params.arm,
          errorOnly: params.errorOnly ? "1" : undefined,
          sort: params.sort,
          direction: params.direction,
          ...facetSearch(params),
        });
        const bounds = windowOverride(window);
        const filters = { ...view.filters, ...bounds.filters };
        const cursor = requireCursor(token, (raw) => parseSpanCursor(raw, filters));
        const page = await deps.listSpans(ctx.projectId, {
          ...view.queryOptions,
          ...bounds.query,
          ...(cursor ? { cursor } : {}),
          limit: params.limit,
        });

        return {
          data: {
            count: page.items.length,
            hasMore: page.hasMore,
            nextCursor:
              page.hasMore && page.nextCursor
                ? encodePageCursor(window, serializeSpanCursor(page.nextCursor, filters))
                : null,
            spans: page.items.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              step: stepKind(span),
              startedAt: span.startedAt.toISOString(),
              durationMs: round(span.durationMs, 1),
              statusCode: span.statusCode,
              serviceName: span.serviceName,
              model: span.model,
              toolName: span.toolName,
              totalTokens: span.totalTokens,
              costUsd: round(span.costUsd, 6),
              experimentName: span.experimentName,
            })),
          },
          truncated: page.hasMore,
          window: window.toJSON(),
          hint: "get_span opens one span (traceId and spanId); get_run_summary tells its run as a conversation.",
        };
      },
    }),
    defineOperation({
      id: "list_logs",
      domain: "observability",
      title: "List logs",
      description:
        "SDK logs and experiment records, as the Logs page lists them, newest first: name, time, trace and span, service, experiment and variant, with body and attributes previewed. Filter by name, experiment, or logs with no trace; paged by cursor. For one trace's ranking records use get_trace_ranking.",
      keywords: ["logs", "events", "sdk logs", "experiment records", "otel logs"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        eventName: z.string().max(200).optional().describe("Log name contains this text."),
        experiment: z.string().max(200).optional().describe("Experiment name contains this text."),
        tracelessOnly: z.boolean().default(false).describe("Only logs not attached to a trace."),
        cursor: cursorParam,
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const { window, token } = resolvePagedWindow(params, WINDOW_PRESETS.traces);
        const view = resolveEventListView({
          project: ctx.projectId,
          eventName: params.eventName,
          experiment: params.experiment,
          tracelessOnly: params.tracelessOnly ? "1" : undefined,
        });
        const bounds = windowOverride(window);
        const filters = { ...view.filters, ...bounds.filters };
        const cursor = requireCursor(token, (raw) => parseEventCursor(raw, filters));
        const page = await deps.listProjectEvents(ctx.projectId, {
          ...view.queryOptions,
          ...bounds.query,
          ...(cursor ? { cursor } : {}),
          limit: params.limit,
        });

        // A log's body and attributes are whatever the SDK logged, prompts included.
        const content = page.items.length > 0 ? await mayReadContent(ctx, deps) : true;
        const tracker = new TruncationTracker();
        tracker.mark(page.hasMore);
        const logs = page.items.map((log) => ({
          id: log.id,
          occurredAt: log.occurredAt.toISOString(),
          eventName: log.eventName,
          label: logPresentation(log.eventName).label,
          traceId: log.traceId,
          spanId: log.spanId,
          serviceName: log.serviceName,
          experimentName: log.experimentName,
          experimentArm: log.experimentArm,
          experimentRole: log.experimentRole,
          body:
            !content || log.body === null || log.body === undefined
              ? null
              : tracker.text(formatAttributeValue(log.body), ATTRIBUTE_VALUE_CHARS),
          attributes: content
            ? previewAttributes(
                log.attributes,
                { cap: LOG_ATTRIBUTE_CAP, chars: LOG_VALUE_CHARS },
                tracker,
              ).attributes
            : null,
          experimentAttributes: previewAttributes(
            experimentAttributesFor(log.experimentAttrs, content),
            { cap: LOG_ATTRIBUTE_CAP, chars: LOG_VALUE_CHARS },
            tracker,
          ).attributes,
          attributesCutAtIngest: log.attrsTruncated,
        }));

        return {
          data: {
            count: logs.length,
            hasMore: page.hasMore,
            nextCursor:
              page.hasMore && page.nextCursor
                ? encodePageCursor(window, serializeEventCursor(page.nextCursor, filters))
                : null,
            logs,
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: contentHint(
            content,
            "A log with a traceId opens with get_run_summary or get_trace.",
          ),
        };
      },
    }),
    defineOperation({
      id: "compare_traces",
      domain: "observability",
      title: "Compare two traces",
      description:
        "Two traces side by side, as the Compare page shows them: name, duration, status, span and error counts, tokens, cost and experiment variant for each, the difference B minus A, and how many of each experiment record type each one has. Use it to compare a slow run with a fast one or two variants.",
      keywords: ["compare", "diff", "side by side", "two runs", "a vs b"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceIdA: traceIdParam,
        traceIdB: traceIdParam.describe("The second trace id; must differ from traceIdA."),
      }),
      async execute(ctx, params) {
        const ids = resolveTraceCompareIds({ a: params.traceIdA, b: params.traceIdB });
        if (!ids) {
          throw invalidParams(
            "traceIdA and traceIdB must be two different 32-character hex trace ids.",
          );
        }
        const [left, right] = await Promise.all([
          deps.getTraceSpansWithTruncation(ctx.projectId, ids[0]),
          deps.getTraceSpansWithTruncation(ctx.projectId, ids[1]),
        ]);
        if (left.spans.length === 0 || right.spans.length === 0) throw notFound("trace");
        const [leftEvents, rightEvents] = await Promise.all([
          deps.listTraceLifecycleEvents(ctx.projectId, ids[0]),
          deps.listTraceLifecycleEvents(ctx.projectId, ids[1]),
        ]);

        const a = comparisonSide(left.spans);
        const b = comparisonSide(right.spans);
        return {
          data: {
            a,
            b,
            difference: {
              durationMs: round(b.durationMs - a.durationMs, 1),
              spanCount: b.spanCount - a.spanCount,
              errorCount: b.errorCount - a.errorCount,
              totalTokens: b.totalTokens - a.totalTokens,
              costUsd: round(b.costUsd - a.costUsd, 6),
            },
            lifecycle: lifecycleCounts(leftEvents, rightEvents),
            spansTruncated: { a: left.truncated, b: right.truncated },
          },
          truncated: left.truncated || right.truncated,
          hint: "get_run_summary on either id shows where the time and tokens went; get_trace_ranking lists one trace's experiment records.",
        };
      },
    }),
    defineOperation({
      id: "get_trace_ranking",
      domain: "observability",
      title: "Trace ranking records",
      description:
        "The Ranking tab of one trace: the experiment records it carries, in order (results, comparisons, skips, fallbacks, drops, outcomes), each with its variant, role and key attributes such as agreement and result counts. Empty when no experiment touched the run. list_logs searches these across runs.",
      keywords: [
        "ranking",
        "experiment records",
        "ranking tab",
        "variant",
        "agreement",
        "lifecycle",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        traceId: traceIdParam,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Records to return (max 100)."),
      }),
      async execute(ctx, params) {
        const traceId = normalizeTraceId(params.traceId);
        const events = await deps.listTraceLifecycleEvents(ctx.projectId, traceId);
        const content = events.length > 0 ? await mayReadContent(ctx, deps) : true;
        const tracker = new TruncationTracker();
        const page = tracker.take(capRows(events, params.limit));

        return {
          data: {
            traceId,
            count: page.length,
            total: events.length,
            records: page.map((event) => {
              const presentation = logPresentation(event.eventName);
              return {
                id: event.id,
                eventName: event.eventName,
                label: presentation.label,
                description: presentation.description,
                occurredAt: event.occurredAt.toISOString(),
                spanId: event.spanId,
                experimentName: event.experimentName,
                experimentArm: event.experimentArm,
                experimentRole: event.experimentRole,
                attributes: salientAttributes(
                  experimentAttributesFor(event.experimentAttrs, content),
                  RANKING_ATTRIBUTE_CAP,
                ).map((attribute) => ({
                  key: attribute.key,
                  label: attribute.label,
                  value: tracker.text(attribute.value, LOG_VALUE_CHARS),
                })),
              };
            }),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            events.length === 0
              ? "No experiment records for this trace: either no experiment touched it, or the trace id is not in this project."
              : "compare_traces puts two runs' records side by side.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_turn",
      domain: "observability",
      title: "Get turn",
      description:
        "One agent turn call by call, as the turn page shows it: each search with its query and top hits, each tool or skill call with its outcome, timing, rank it was offered at and error, plus the session's previous and next turn. Turn ids come from Agent health insights and tasks. A call with a traceId opens with get_run_summary.",
      keywords: ["turn", "one turn", "calls", "search then invoke", "session", "turn detail"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        turnId: z.string().min(1).max(64).describe("The turn id (a UUID)."),
        limit: z.number().int().min(1).max(100).default(50).describe("Calls to return (max 100)."),
      }),
      async execute(ctx, params) {
        // The page 404s without Agent health, the only surface linking here.
        if (!(await deps.agentHealthEnabled(ctx.projectId, ctx.organizationId)))
          throw notFound("turn");
        const turn = await deps.loadTurnDetail(ctx.projectId, params.turnId.trim());
        if (!turn) throw notFound("turn");

        const content = await mayReadContent(ctx, deps);
        const tracker = new TruncationTracker();
        const calls = tracker.take(capRows(turn.calls, params.limit));
        // The user's ask and every search's words are captured text.
        const text = (value: string | null, chars: number) =>
          !content || value === null ? null : tracker.text(value, chars);
        return {
          data: {
            id: turn.id,
            sessionId: turn.sessionId,
            turnSource: turn.turnSource,
            lane: turn.lane,
            status: turn.status,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            previousTurnId: turn.previousTurnId,
            nextTurnId: turn.nextTurnId,
            ...(turn.linked
              ? {
                  linked: {
                    ...turn.linked,
                    costUsd: round(turn.linked.costUsd, 6),
                    asked: text(turn.linked.asked, ATTRIBUTE_VALUE_CHARS),
                    searched: text(turn.linked.searched, ATTRIBUTE_VALUE_CHARS),
                  },
                }
              : {}),
            callCount: turn.calls.length,
            calls: calls.map((call) =>
              call.kind === "search"
                ? {
                    ordinal: call.ordinal,
                    kind: call.kind,
                    occurredAt: call.occurredAt,
                    gapMs: call.gapMs,
                    query:
                      call.query?.state === "captured"
                        ? text(call.query.text, LOG_VALUE_CHARS * 2)
                        : null,
                    queryState: call.query?.state ?? null,
                    hitCount: call.hitCount,
                    hits: call.hits,
                    tookMs: call.tookMs,
                    traceId: call.traceId,
                    spanId: call.spanId,
                  }
                : {
                    ordinal: call.ordinal,
                    kind: call.kind,
                    eventType: call.eventType,
                    occurredAt: call.occurredAt,
                    gapMs: call.gapMs,
                    targetType: call.targetType,
                    targetId: call.targetId,
                    outcome: call.outcome,
                    tookMs: call.tookMs,
                    offeredRank: call.offeredRank,
                    errorMessage:
                      call.errorMessage === null
                        ? null
                        : tracker.text(call.errorMessage, ATTRIBUTE_VALUE_CHARS),
                    traceId: call.traceId,
                    spanId: call.spanId,
                  },
            ),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            "A call with a traceId opens with get_run_summary. previousTurnId and nextTurnId walk the session with get_turn.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_run_stats",
      domain: "observability",
      title: "Run totals for a filtered set",
      description:
        "Totals for the runs matching the same filters as list_traces, as the Runs page header shows them: run count, failed runs, error rate, p50, p95 and p99 duration, tokens, cost, and runs per day or hour. For the unfiltered project get_trace_health is cheaper; for spend to quote prefer get_cost_by_day.",
      keywords: [
        "run stats",
        "filtered totals",
        "error rate for",
        "p99",
        "how many runs",
        "volume",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        ...traceFilters,
        ...runFilterParams,
        ...spanFacetParams,
        bucket: z
          .enum(["day", "hour"])
          .default("day")
          .describe(
            `Volume series granularity. Hourly applies to windows up to ${HOURLY_VOLUME_MAX_DAYS} days.`,
          ),
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const query = resolveRunListQuery(ctx.projectId, params, window);
        const days = (window.until.getTime() - window.since.getTime()) / DAY_MS;
        const hourly = params.bucket === "hour" && days <= HOURLY_VOLUME_MAX_DAYS;
        const aggregate = await deps.getTraceAggregates(ctx.projectId, {
          ...query.queryOptions,
          since: window.since,
          until: window.until,
          volumeBucket: hourly ? "hour" : "day",
        });

        const hints = [
          ...(window.clamped ? ["The requested window exceeded the maximum and was clamped."] : []),
          ...(params.bucket === "hour" && !hourly
            ? [
                `Hourly volume needs a window of ${HOURLY_VOLUME_MAX_DAYS} days or less; the series is daily.`,
              ]
            : []),
          "list_traces with the same filters lists these runs.",
        ];
        return {
          data: {
            source: "spans" as const,
            runs: aggregate.count,
            failedRuns: aggregate.errorCount,
            errorRate: round(aggregate.errorRate),
            p50DurationMs: round(aggregate.p50DurationMs, 1),
            p95DurationMs: round(aggregate.p95DurationMs, 1),
            p99DurationMs: round(aggregate.p99DurationMs, 1),
            totalTokens: aggregate.totalTokens,
            costUsd: round(aggregate.costUsd, 6),
            bucket: hourly ? "hour" : "day",
            volume: aggregate.volume.map((point) => ({
              day: point.day,
              ...(point.hour !== undefined ? { hour: point.hour } : {}),
              runs: point.count,
              failedRuns: point.errorCount,
            })),
          },
          window: window.toJSON(),
          hint: hints.join(" "),
        };
      },
    }),
  ];
}

function comparisonSide(spans: readonly OtelSpan[]) {
  const summary = summarizeTraceForComparison(spans);
  return {
    ...summary,
    startedAt: summary.startedAt.toISOString(),
    endedAt: summary.endedAt.toISOString(),
    durationMs: round(summary.durationMs, 1) ?? 0,
    costUsd: round(summary.costUsd, 6) ?? 0,
  };
}

/** The Compare page's lifecycle table: each record type with its count per trace. */
function lifecycleCounts(
  left: readonly TraceLifecycleEvent[],
  right: readonly TraceLifecycleEvent[],
) {
  const count = (events: readonly TraceLifecycleEvent[]) => {
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.eventName, (counts.get(event.eventName) ?? 0) + 1);
    return counts;
  };
  const a = count(left);
  const b = count(right);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  return {
    totalA: left.length,
    totalB: right.length,
    byType: names.map((eventName) => ({
      eventName,
      label: logPresentation(eventName).label,
      a: a.get(eventName) ?? 0,
      b: b.get(eventName) ?? 0,
    })),
  };
}
