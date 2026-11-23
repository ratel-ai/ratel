import { categorize, toolCallCounts } from "@/lib/ingest/categorize";
import type { CloudEvent, ToolCallBlock } from "@/lib/ingest/cloud-schema";
import { agentOnlyTrace, langGraphTrace } from "@/lib/ingest/otlp/agent-span-fixtures";
import { attrString, attrStructured } from "@/lib/ingest/otlp/anyvalue";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { toolSpanArguments, toRow } from "@/lib/ingest/otlp/reconstruct";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { toOtelSpanRows } from "@/lib/ingest/otlp/span-rows";
import type { AttrMap, AttrValue, DecodedSpan, GroupedCall } from "@/lib/ingest/otlp/types";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";

/**
 * Owned from upstream's `lib/tool-counts-backfill/fixtures.ts` (the backfill is not part of this
 * edition): the trace shapes the tool-count tests ingest, without `storedTrace`, which only the
 * backfill reads.
 *
 * Traces stored the way ingest stored them before both fixes: no agent-span
 * dedupe (Cause A) and every content tool call counted (Cause B). Shared by
 * the recompute unit tests, the PGlite test and the sample dry run.
 */

export const FIXTURE_ORG = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_PROJECT = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-10-20T10:00:00Z");

type Message = { role: string; parts: Record<string, AttrValue>[] };

const user: Message = {
  role: "user",
  parts: [{ type: "text", content: "Find the refund policy" }],
};
const call = (id: string, name: string, args: Record<string, AttrValue>): Message => ({
  role: "assistant",
  parts: [{ type: "tool_call", id, name, arguments: args }],
});
const result = (id: string, response: string): Message => ({
  role: "tool",
  parts: [{ type: "tool_call_response", id, response }],
});
const answer: Message = {
  role: "assistant",
  parts: [{ type: "text", content: "Refunds within 30 days." }],
};

const callSearch = call("call_search", "search", { q: "refund policy" });
const callFetch = call("call_fetch", "fetch", { url: "https://acme.test/refunds" });
const searchResult = result("call_search", "https://acme.test/refunds");
const fetchResult = result("call_fetch", "Refunds within 30 days.");

/** search, then fetch, then the answer: the input history grows by one call each step. */
const STEPS: { input: Message[]; output: Message[] }[] = [
  { input: [user], output: [callSearch] },
  { input: [user, callSearch, searchResult], output: [callFetch] },
  { input: [user, callSearch, searchResult, callFetch, fetchResult], output: [answer] },
];

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  name: string,
  attributes: AttrMap,
  offsetMs: number,
  scopeName: string | null = null,
): DecodedSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startUnixMs: START + offsetMs,
    endUnixMs: START + offsetMs + 100,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "refund-agent" },
    scopeName,
  };
}

const chat: AttrMap = {
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "openai",
  "gen_ai.request.model": "gpt-5.5",
  "gen_ai.usage.input_tokens": 500,
  "gen_ai.usage.output_tokens": 50,
};
const tool = (name: string, id: string): AttrMap => ({
  "gen_ai.operation.name": "execute_tool",
  "gen_ai.tool.name": name,
  "gen_ai.tool.call.id": id,
});

/** One trace of a counting shape: model calls in order, and tool spans parented to one call each. */
function shapeTrace(
  traceId: string,
  steps: { input: Message[]; output?: Message[] }[],
  toolSpans: { step: number; name: string; id: string }[],
): DecodedSpan[] {
  const anchorId = (i: number) => `500000000000001${i}`;
  return [
    ...steps.map((step, i) =>
      span(
        traceId,
        anchorId(i),
        null,
        "chat gpt-5.5",
        {
          ...chat,
          "gen_ai.input.messages": JSON.stringify(step.input),
          ...(step.output ? { "gen_ai.output.messages": JSON.stringify(step.output) } : {}),
        },
        (i + 1) * 1_000,
      ),
    ),
    ...toolSpans.map((t, i) =>
      span(
        traceId,
        `500000000000002${i}`,
        anchorId(t.step),
        `execute_tool ${t.name}`,
        tool(t.name, t.id),
        (t.step + 1) * 1_000 + 500,
      ),
    ),
  ];
}

/**
 * Traces whose true counts differ from the plain rule "output plus owned spans
 * by name". Ingest and the backfill must both give `truth`.
 */
export const TOOL_COUNT_SHAPES: {
  name: string;
  truth: Record<string, number>;
  spans: () => DecodedSpan[];
}[] = [
  {
    name: "the first call has no output, a later call has output, the span is under the later call",
    truth: { search: 1, fetch: 1 },
    spans: () =>
      shapeTrace(
        "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
        [{ input: [user] }, { input: [user, callSearch, searchResult], output: [callFetch] }],
        [{ step: 1, name: "search", id: "call_search" }],
      ),
  },
  {
    name: "a later call has no output, the span is under it",
    truth: { search: 1 },
    spans: () =>
      shapeTrace(
        "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
        [{ input: [user], output: [callSearch] }, { input: [user, callSearch, searchResult] }],
        [{ step: 1, name: "search", id: "call_search" }],
      ),
  },
  {
    name: "the output has the same tool name, the span has another id",
    truth: { search: 2 },
    spans: () =>
      shapeTrace(
        "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3",
        [{ input: [user], output: [callSearch] }],
        [{ step: 0, name: "search", id: "call_search_2" }],
      ),
  },
  {
    name: "an empty tool message after the history call is dropped",
    truth: { search: 1, fetch: 1 },
    spans: () =>
      shapeTrace(
        "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        [
          { input: [user], output: [callSearch] },
          { input: [user, callSearch, { role: "tool", parts: [] }], output: [callFetch] },
        ],
        [],
      ),
  },
  {
    name: "a user tool_result part after the history call is dropped",
    truth: { search: 1, fetch: 1 },
    spans: () =>
      shapeTrace(
        "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5",
        [
          { input: [user], output: [callSearch] },
          {
            input: [
              user,
              callSearch,
              {
                role: "user",
                parts: [{ type: "tool_result", tool_use_id: "call_search", content: "ok" }],
              },
            ],
            output: [callFetch],
          },
        ],
        [],
      ),
  },
  {
    name: "an id-less call repeated with the same arguments after a dropped tool message counts for each call",
    truth: { search: 2 },
    spans: () => {
      const idless = call("", "search", { q: "refund policy" });
      return shapeTrace(
        "d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6",
        [
          { input: [user], output: [idless] },
          { input: [user, idless, { role: "tool", parts: [] }], output: [idless] },
        ],
        [],
      );
    },
  },
];

/**
 * Semconv content on the spans, an `invoke_agent` root with the run's summed
 * usage (Cause A) and the tool spans under the root. Truth: 3 model calls,
 * search = 1, fetch = 1.
 */
export function semconvAgentTrace(traceId = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"): DecodedSpan[] {
  const root = "4000000000000001";
  return [
    span(
      traceId,
      root,
      null,
      "invoke_agent refund-agent",
      {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 1_500,
        "gen_ai.usage.output_tokens": 150,
      },
      0,
    ),
    ...STEPS.map((step, i) =>
      span(
        traceId,
        `400000000000001${i}`,
        root,
        "chat gpt-5.5",
        {
          ...chat,
          "gen_ai.input.messages": JSON.stringify(step.input),
          "gen_ai.output.messages": JSON.stringify(step.output),
        },
        (i + 1) * 1_000,
      ),
    ),
    span(
      traceId,
      "4000000000000021",
      root,
      "execute_tool search",
      tool("search", "call_search"),
      1_500,
    ),
    span(
      traceId,
      "4000000000000022",
      root,
      "execute_tool fetch",
      tool("fetch", "call_fetch"),
      2_500,
    ),
  ];
}

/**
 * AI SDK before `ai.response.toolCalls` was mapped: input only, tool calls
 * visible only in later calls' history, no tool spans. Truth: search = 1, fetch = 1.
 */
export function aiSdkHistoryTrace(traceId = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"): DecodedSpan[] {
  const root = "5000000000000001";
  const toAi = (m: Message) => ({
    role: m.role,
    content: m.parts.map((p) =>
      p.type === "tool_call"
        ? { type: "tool-call", toolCallId: p.id, toolName: p.name, input: p.arguments }
        : p.type === "tool_call_response"
          ? { type: "tool-result", toolCallId: p.id, toolName: "", output: p.response }
          : { type: "text", text: p.content },
    ),
  });
  return [
    span(traceId, root, null, "ai.generateText", { "ai.operationId": "ai.generateText" }, 0),
    ...STEPS.map((step, i) =>
      span(
        traceId,
        `500000000000001${i}`,
        root,
        "ai.generateText.doGenerate",
        {
          "ai.operationId": "ai.generateText.doGenerate",
          "ai.model.provider": "openai.responses",
          "gen_ai.request.model": "gpt-5.5",
          "gen_ai.usage.input_tokens": 500,
          "gen_ai.usage.output_tokens": 50,
          "ai.prompt.messages": JSON.stringify(step.input.map(toAi)),
        },
        (i + 1) * 1_000,
      ),
    ),
  ];
}

/**
 * The same AI SDK shape with `ai.toolCall` spans under the root, beside the model
 * calls: no call owns them. The calls show only in later input. Truth: search = 1,
 * fetch = 1.
 */
export function aiSdkToolSpanTrace(traceId = "e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4"): DecodedSpan[] {
  // Own span ids: an event's dedupe key is its span id, per project.
  const ownId = (id: string) => `7${id.slice(1)}`;
  const spans = aiSdkHistoryTrace(traceId).map((s) => ({
    ...s,
    spanId: ownId(s.spanId),
    parentSpanId: s.parentSpanId && ownId(s.parentSpanId),
  }));
  const root = spans[0].spanId;
  const toolCall = (spanId: string, name: string, id: string, offsetMs: number) =>
    span(
      traceId,
      spanId,
      root,
      "ai.toolCall",
      {
        "ai.operationId": "ai.toolCall",
        "ai.toolCall.name": name,
        "ai.toolCall.id": id,
        "ai.toolCall.args": "{}",
      },
      offsetMs,
    );
  return [
    ...spans,
    toolCall("7000000000000021", "search", "call_search", 1_500),
    toolCall("7000000000000022", "fetch", "call_fetch", 2_500),
  ];
}

/** A health import: `invoke_agent` root without usage, two chats, one tool. Never deduped. */
export function healthImportTrace(traceId = "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3"): DecodedSpan[] {
  const root = "6000000000000001";
  const scope = "ratel.health-import";
  return [
    span(
      traceId,
      root,
      null,
      "invoke_agent support",
      {
        "gen_ai.operation.name": "invoke_agent",
        "ratel.import.source": "langfuse",
      },
      0,
      scope,
    ),
    span(
      traceId,
      "6000000000000002",
      root,
      "chat gpt-5.5",
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 100,
      },
      1_000,
      scope,
    ),
    span(
      traceId,
      "6000000000000003",
      "6000000000000002",
      "execute_tool lookup",
      tool("lookup", "imp-1"),
      1_200,
      scope,
    ),
  ];
}

/**
 * A later turn of a conversation, AI SDK shape, input only: its first call
 * re-sends the earlier turn's `search`, its second call shows its own `fetch`.
 * Truth for this trace: fetch = 1. `search` was counted in the earlier trace.
 */
export function laterTurnTrace(
  withIds: boolean,
  traceId = "f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5",
): DecodedSpan[] {
  const root = "8000000000000001";
  const toolCall = (toolCallId: string, toolName: string) => ({
    role: "assistant",
    content: [{ type: "tool-call", ...(withIds ? { toolCallId } : {}), toolName, input: {} }],
  });
  const toolResult = (toolCallId: string, toolName: string) => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: "ok" }],
  });
  const ask = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  const earlier = [
    ask("first"),
    toolCall("c1", "search"),
    toolResult("c1", "search"),
    ask("second"),
  ];
  const inputs = [earlier, [...earlier, toolCall("c2", "fetch"), toolResult("c2", "fetch")]];
  return [
    span(traceId, root, null, "ai.generateText", { "ai.operationId": "ai.generateText" }, 0),
    ...inputs.map((input, i) =>
      span(
        traceId,
        `800000000000001${i}`,
        root,
        "ai.generateText.doGenerate",
        {
          "ai.operationId": "ai.generateText.doGenerate",
          "ai.model.provider": "openai.responses",
          "gen_ai.request.model": "gpt-5.5",
          "gen_ai.usage.input_tokens": 500,
          "ai.prompt.messages": JSON.stringify(input),
        },
        (i + 1) * 1_000,
      ),
    ),
  ];
}

const ALL_TOOLS = {
  search_tasks: 1,
  get_task: 1,
  assign_task: 1,
  get_user: 1,
  list_tasks: 1,
  find_board: 1,
  archive_board: 1,
  notify: 1,
};
/** A plain exception in `archive_board` aborts run 3: `notify` never runs. */
const { notify: _notify, ...ABORTED_RUN_3 } = ALL_TOOLS;

/**
 * True tool counts of the real captures: the agent script in
 * `lib/otlp/__fixtures__/real/README.md`. Each capture is one conversation of
 * three turns, one trace per turn, and each turn's input re-sends earlier turns.
 */
export const REAL_FIXTURE_TRUE_COUNTS: Record<string, Record<string, number>> = {
  "openllmetry-openai": ALL_TOOLS,
  "pydantic-ai": ABORTED_RUN_3,
  "pydantic-ai-modelretry": ALL_TOOLS,
  mastra: ALL_TOOLS,
  "vercel-ai": ALL_TOOLS,
  "vercel-ai-stream": { search_tasks: 1, get_task: 1, assign_task: 1 },
};

/** A real capture's spans, one list per trace. */
export function realFixtureTraces(fixture: string): DecodedSpan[][] {
  const traces = new Map<string, DecodedSpan[]>();
  for (const body of loadFixture(fixture)) {
    for (const s of decodeOtlp(body.contentType, body.bytes)) {
      traces.set(s.traceId, [...(traces.get(s.traceId) ?? []), s]);
    }
  }
  return [...traces.values()];
}

/** Every fixture trace, as the old ingest stored them. */
export function fixtureTraces(): DecodedSpan[][] {
  return [
    semconvAgentTrace(),
    aiSdkHistoryTrace(),
    langGraphTrace(),
    agentOnlyTrace(),
    healthImportTrace(),
  ];
}

/** What the pre-fix `/v1/traces` wrote for `spans`: event+metric rows and span rows. */
export function legacyIngest(
  projectId: string,
  spans: DecodedSpan[],
): { rows: EventWithMetric[]; spanRows: NewOtelSpan[] } {
  // The old ingest did not map a call's response tool calls to output messages.
  for (const span of spans) delete span.attributes["ai.response.toolCalls"];
  normalizeAiSdkSpans(spans);
  return {
    rows: groupSpans(spans).map((c) => legacyRow(projectId, c)),
    spanRows: toOtelSpanRows(projectId, spans),
  };
}

/**
 * What the old ingest stored for one call: every content tool call counted, and
 * a synthetic id-less tool call only for a tool span whose name no content
 * block has. Nothing in production builds this row any more.
 */
function legacyRow(projectId: string, call: GroupedCall): EventWithMetric {
  const row = toRow(projectId, { ...call, toolSpans: [] });
  // The old ingest did not store where the input ends.
  const { input_message_count: _inputCount, ...payload } = row.event.payload!;
  row.event.payload = payload;
  const content = payload.messages.filter((m) => !(m.role === "user" && m.content === ""));
  const named = new Set(toolCallCounts(content).keys());
  const extra: ToolCallBlock[] = call.toolSpans.flatMap((span) => {
    const name = attrString(span.attributes, GEN_AI.toolName);
    return name && !named.has(name)
      ? [{ type: "tool_call", id: "", name, arguments: toolSpanArguments(span) }]
      : [];
  });
  if (extra.length === 0) return { ...row, metric: { ...row.metric, ...legacyMetric(payload) } };
  const hasCatalog =
    attrStructured(call.anchor.attributes, GEN_AI.toolDefinitions) != null ||
    attrStructured(call.detailsEvent?.attributes ?? {}, GEN_AI.toolDefinitions) != null;
  const synthesized = hasCatalog
    ? []
    : [...new Set(extra.map((b) => b.name))].map((name) => ({ name, parameters: {} }));
  const tools = [...(payload.tools ?? []), ...synthesized];
  const legacy: CloudEvent = {
    ...payload,
    messages: [...content, { role: "assistant", content: extra }],
    ...(tools.length > 0 ? { tools } : {}),
  };
  return {
    event: { ...row.event, payload: legacy },
    metric: { ...row.metric, ...legacyMetric(legacy) },
  };
}

function legacyMetric(payload: CloudEvent) {
  const { tokensByCategory, splits, toolsByName, toolsTotalCount, toolsUsedCount } =
    categorize(payload);
  return { tokensByCategory, splits, toolsByName, toolsTotalCount, toolsUsedCount };
}
