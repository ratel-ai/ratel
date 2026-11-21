import { createHash } from "node:crypto";
import {
  SITE_COPILOT_AGENT,
  SITE_COPILOT_MODEL,
  SITE_COPILOT_SYSTEM_PROMPT,
  SITE_COPILOT_TOOLS,
  SITE_COPILOT_VERSION,
} from "@/lib/console/seed/site-copilot-catalog";
import type { SiteConversation, SitePlan, SiteTurn } from "@/lib/console/seed/site-copilot-plan";
import { hexOf } from "@/lib/console/seed/site-copilot-rng";
import type { SiteCall } from "@/lib/console/seed/site-copilot-turns";

/**
 * The Site Copilot plan as an OpenTelemetry exporter with content capture on
 * sends it: OTLP/JSON `ExportTraceServiceRequest` bodies for `POST /v1/traces`.
 * Each turn is one trace in the GenAI semantic conventions: an
 * `invoke_agent` span, one `chat` span per model round trip and one
 * `execute_tool` span per tool call, all carrying the conversation id and the
 * user id. Chat spans capture the messages (the conversation so far, the
 * user's ask, tool calls and results, the reply), the system instructions and
 * the tool menu; tool spans capture arguments and results, and a failed call
 * sets `error.type` and an error status.
 *
 * The plan is placed on a calendar ending at `anchorMs`: weekday working
 * hours on US Central time, quiet nights and weekends, slowly growing use.
 * Deterministic: the same plan and anchor give byte-identical bodies, and ids
 * hash the turn's key, so they do not depend on the anchor.
 */

export const SITE_COPILOT_DAYS = 30;
export const SITE_COPILOT_MAX_BODY_SPANS = 1_000;
/** Bodies stay under this many bytes; the route accepts 4 MB. */
export const SITE_COPILOT_MAX_BODY_BYTES = 3_500_000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The newest turn ends at least this long before the anchor. */
const END_MARGIN_MS = 2 * MINUTE_MS;
/** The job sites keep US Central time; UTC-5 through the season the demo covers. */
const SITE_UTC_OFFSET_MS = -5 * 3_600_000;
const BODY_ENVELOPE_BYTES = 20_000;
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_ERROR = 2;
/** Tokens of the system prompt and the tool menu, sent with every model call. */
const PROMPT_BASE_TOKENS = 1_850;

export interface SiteOtlpOptions {
  /** The end of the window, epoch ms. */
  anchorMs: number;
  days?: number;
}

/** A chat span, by the ids ingest keys its `events` row with (`gen_ai.response.id`). */
export interface SiteChatSpan {
  traceId: string;
  spanId: string;
  responseId: string;
}

/** The `events.dedupe_hash` ingest gives a model call with this response id (`otlpDedupeHash`). */
export function chatDedupeHash(responseId: string): string {
  return createHash("sha256").update(responseId).digest("hex");
}

export interface SiteOtlpResult {
  batches: object[];
  chatSpans: SiteChatSpan[];
  /** The first span's start and the last span's end, epoch ms. */
  window: { startMs: number; endMs: number };
  stats: { traces: number; spans: number; toolSpans: number; chatSpans: number; bodies: number };
}

/* --- calendar ------------------------------------------------------------------------ */

function activityWeight(ms: number): number {
  const local = new Date(ms + SITE_UTC_OFFSET_MS);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const daily =
    hour < 5
      ? 0.02
      : hour < 6
        ? 0.15
        : hour < 7
          ? 0.6
          : hour < 16
            ? 1
            : hour < 18
              ? 0.55
              : hour < 21
                ? 0.15
                : 0.03;
  const weekday = local.getUTCDay();
  return daily * (weekday === 0 ? 0.08 : weekday === 6 ? 0.22 : 1);
}

/** Maps a position in [0, 1) to an instant, spending positions where the sites are busy. */
export function siteCalendar(startMs: number, endMs: number): (position: number) => number {
  const minutes = Math.max(1, Math.floor((endMs - startMs) / MINUTE_MS));
  const cumulative = new Float64Array(minutes);
  let total = 0;
  for (let i = 0; i < minutes; i++) {
    // Use grows about a third over the window.
    total += activityWeight(startMs + i * MINUTE_MS) * (0.85 + (0.3 * i) / minutes);
    cumulative[i] = total;
  }
  return (position) => {
    const target = Math.min(Math.max(position, 0), 0.999_999) * total;
    let lo = 0;
    let hi = minutes - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const before = lo === 0 ? 0 : cumulative[lo - 1]!;
    const within = (target - before) / Math.max(cumulative[lo]! - before, Number.EPSILON);
    return startMs + lo * MINUTE_MS + Math.floor(within * MINUTE_MS);
  };
}

/* --- timeline ------------------------------------------------------------------------- */

interface Round {
  chatStart: number;
  chatEnd: number;
  call?: SiteCall;
  callStart?: number;
  callEnd?: number;
}

interface TurnLayout {
  turn: SiteTurn;
  history: readonly SiteTurn[];
  start: number;
  end: number;
  rounds: Round[];
}

function layoutTurn(turn: SiteTurn, history: readonly SiteTurn[], start: number): TurnLayout {
  let t = start + 4;
  const rounds: Round[] = [];
  for (let r = 0; r <= turn.calls.length; r++) {
    const chatStart = t;
    const chatEnd = chatStart + turn.modelMs[r]!;
    t = chatEnd + 6;
    const call = turn.calls[r];
    if (call) {
      const callStart = t;
      t = callStart + call.tookMs + 9;
      rounds.push({ chatStart, chatEnd, call, callStart, callEnd: callStart + call.tookMs });
    } else {
      rounds.push({ chatStart, chatEnd });
    }
  }
  return { turn, history, start, end: t + 3, rounds };
}

function layoutConversation(conversation: SiteConversation, startMs: number): TurnLayout[] {
  const layouts: TurnLayout[] = [];
  let cursor = startMs;
  conversation.turns.forEach((turn, i) => {
    const layout = layoutTurn(
      turn,
      conversation.turns.slice(0, i),
      i === 0 ? cursor : cursor + turn.gapBeforeMs,
    );
    layouts.push(layout);
    cursor = layout.end;
  });
  return layouts;
}

/** The conversation from its calendar start, moved earlier when it would run past the window's end. */
function placeConversation(
  conversation: SiteConversation,
  startMs: number,
  latestEndMs: number,
): TurnLayout[] {
  const draft = layoutConversation(conversation, startMs);
  const overrun = draft[draft.length - 1]!.end - latestEndMs;
  return overrun > 0 ? layoutConversation(conversation, startMs - overrun) : draft;
}

/* --- content ------------------------------------------------------------------------ */

type Part =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, string | number> }
  | { type: "tool_call_response"; id: string; response: string };

interface Message {
  role: "user" | "assistant" | "tool";
  parts: Part[];
  finish_reason?: string;
}

const TOOL_DEFINITIONS = JSON.stringify(
  SITE_COPILOT_TOOLS.map((tool) => ({
    type: "function",
    name: tool.id,
    description: tool.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([name, type]) => [name, { type }]),
      ),
    },
  })),
);
const SYSTEM_INSTRUCTIONS = JSON.stringify([{ type: "text", content: SITE_COPILOT_SYSTEM_PROMPT }]);

const text = (content: string): Part => ({ type: "text", content });

function callIdOf(seed: number, turn: SiteTurn, i: number): string {
  return `toolu_${hexOf(`${seed}:${turn.key}:call:${i}`, 24)}`;
}

function responseOf(call: SiteCall): string {
  return call.outcome === "error"
    ? `Error: ${call.errorMessage ?? call.errorType ?? "failed"}`
    : JSON.stringify(call.result ?? null);
}

function assistantCall(seed: number, turn: SiteTurn, i: number): Message {
  const call = turn.calls[i]!;
  return {
    role: "assistant",
    parts: [
      ...(call.say ? [text(call.say)] : []),
      { type: "tool_call", id: callIdOf(seed, turn, i), name: call.tool, arguments: call.args },
    ],
  };
}

/** What model call `r` of a turn reads: the conversation so far, the ask, and the calls before it. */
function inputOf(seed: number, layout: TurnLayout, r: number): Message[] {
  const history = layout.history.flatMap((past): Message[] => [
    { role: "user", parts: [text(past.ask)] },
    { role: "assistant", parts: [text(past.reply)] },
  ]);
  const turn = layout.turn;
  const earlier = turn.calls.slice(0, r).flatMap((call, i): Message[] => [
    assistantCall(seed, turn, i),
    {
      role: "tool",
      parts: [
        { type: "tool_call_response", id: callIdOf(seed, turn, i), response: responseOf(call) },
      ],
    },
  ]);
  return [...history, { role: "user", parts: [text(turn.ask)] }, ...earlier];
}

function outputOf(seed: number, turn: SiteTurn, r: number): Message[] {
  if (r < turn.calls.length)
    return [{ ...assistantCall(seed, turn, r), finish_reason: "tool_call" }];
  return [{ role: "assistant", parts: [text(turn.reply)], finish_reason: "stop" }];
}

/* --- spans ---------------------------------------------------------------------------- */

type AttrValue = string | number | boolean | readonly string[];
type Attrs = Array<readonly [string, AttrValue]>;

interface SpanDraft {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  start: number;
  end: number;
  attrs: Attrs;
  error?: string;
}

function anyValue(value: AttrValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
}

function encodeSpan(traceId: string, span: SpanDraft): Record<string, unknown> {
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: `${Math.round(span.start)}000000`,
    endTimeUnixNano: `${Math.round(Math.max(span.start, span.end))}000000`,
    attributes: span.attrs.map(([key, value]) => ({ key, value: anyValue(value) })),
    status: span.error ? { code: STATUS_ERROR, message: span.error } : {},
  };
}

const tokensOf = (chars: number): number => Math.ceil(chars / 4);

function traceSpans(
  seed: number,
  conversation: SiteConversation,
  layout: TurnLayout,
): { traceId: string; spans: SpanDraft[]; chats: SiteChatSpan[] } {
  const { turn } = layout;
  const traceId = hexOf(`site-copilot:${seed}:trace:${turn.key}`, 32);
  const spanId = (label: string) => hexOf(`site-copilot:${seed}:span:${turn.key}:${label}`, 16);
  const rootId = spanId("root");
  const who: Attrs = [
    ["gen_ai.conversation.id", conversation.id],
    ["user.id", conversation.userId],
  ];
  const spans: SpanDraft[] = [];
  const chats: SiteChatSpan[] = [];
  layout.rounds.forEach((round, r) => {
    const input = JSON.stringify(inputOf(seed, layout, r));
    const outputMessages = outputOf(seed, turn, r);
    const output = JSON.stringify(outputMessages);
    const outputText = outputMessages[0]!.parts.reduce(
      (sum, part) => sum + (part.type === "text" ? part.content.length : 60),
      0,
    );
    const chatId = spanId(`chat${r}`);
    const responseId = `msg_${hexOf(`site-copilot:${seed}:response:${turn.key}:${r}`, 24)}`;
    chats.push({ traceId, spanId: chatId, responseId });
    spans.push({
      spanId: chatId,
      parentSpanId: rootId,
      name: `chat ${SITE_COPILOT_MODEL}`,
      kind: KIND_CLIENT,
      start: round.chatStart,
      end: round.chatEnd,
      attrs: [
        ["gen_ai.operation.name", "chat"],
        ["gen_ai.provider.name", "anthropic"],
        ["gen_ai.request.model", SITE_COPILOT_MODEL],
        ["gen_ai.response.model", SITE_COPILOT_MODEL],
        ["gen_ai.response.id", responseId],
        ["gen_ai.usage.input_tokens", PROMPT_BASE_TOKENS + tokensOf(input.length)],
        ["gen_ai.usage.output_tokens", tokensOf(outputText) + 12],
        ["gen_ai.response.finish_reasons", [r < turn.calls.length ? "tool_call" : "stop"]],
        ...who,
        ["gen_ai.system_instructions", SYSTEM_INSTRUCTIONS],
        ["gen_ai.input.messages", input],
        ["gen_ai.output.messages", output],
        ["gen_ai.tool.definitions", TOOL_DEFINITIONS],
      ],
    });
    const call = round.call;
    if (!call) return;
    spans.push({
      spanId: spanId(`tool${r}`),
      parentSpanId: rootId,
      name: `execute_tool ${call.tool}`,
      kind: KIND_INTERNAL,
      start: round.callStart!,
      end: round.callEnd!,
      attrs: [
        ["gen_ai.operation.name", "execute_tool"],
        ["gen_ai.tool.name", call.tool],
        ["gen_ai.tool.call.id", callIdOf(seed, turn, r)],
        ["gen_ai.tool.type", "function"],
        ...(call.outcome === "error" ? ([["error.type", call.errorType ?? "error"]] as const) : []),
        ...who,
        ["gen_ai.tool.call.arguments", JSON.stringify(call.args)],
        ...(call.outcome === "error"
          ? []
          : ([["gen_ai.tool.call.result", JSON.stringify(call.result ?? null)]] as const)),
      ],
      ...(call.outcome === "error"
        ? { error: call.errorMessage ?? call.errorType ?? "error" }
        : {}),
    });
  });
  spans.sort((a, b) => a.end - b.end || (a.spanId < b.spanId ? -1 : 1));
  spans.push({
    spanId: rootId,
    parentSpanId: null,
    name: `invoke_agent ${SITE_COPILOT_AGENT}`,
    kind: KIND_INTERNAL,
    start: layout.start,
    end: layout.end,
    attrs: [
      ["gen_ai.operation.name", "invoke_agent"],
      ["gen_ai.agent.name", SITE_COPILOT_AGENT],
      ["gen_ai.provider.name", "anthropic"],
      ...who,
    ],
  });
  return { traceId, spans, chats };
}

/* --- bodies --------------------------------------------------------------------------- */

const RESOURCE = {
  attributes: (
    [
      ["service.name", SITE_COPILOT_AGENT],
      ["service.version", SITE_COPILOT_VERSION],
      ["deployment.environment.name", "production"],
      ["telemetry.sdk.name", "opentelemetry"],
      ["telemetry.sdk.language", "nodejs"],
    ] as const
  ).map(([key, value]) => ({ key, value: anyValue(value) })),
};

class BodyWriter {
  readonly bodies: object[] = [];
  private spans: Record<string, unknown>[] = [];
  private bytes = 0;

  /** One trace's spans, always in one body. */
  add(spans: readonly Record<string, unknown>[]): void {
    const bytes = spans.reduce((sum, span) => sum + Buffer.byteLength(JSON.stringify(span)) + 1, 0);
    const fits =
      this.spans.length + spans.length <= SITE_COPILOT_MAX_BODY_SPANS &&
      this.bytes + bytes < SITE_COPILOT_MAX_BODY_BYTES - BODY_ENVELOPE_BYTES;
    if (!fits) this.flush();
    this.spans.push(...spans);
    this.bytes += bytes;
  }

  flush(): void {
    if (this.spans.length === 0) return;
    this.bodies.push({
      resourceSpans: [
        {
          resource: RESOURCE,
          scopeSpans: [
            {
              scope: { name: SITE_COPILOT_AGENT, version: SITE_COPILOT_VERSION },
              spans: this.spans,
            },
          ],
        },
      ],
    });
    this.spans = [];
    this.bytes = 0;
  }
}

export function renderSiteCopilotOtlp(plan: SitePlan, opts: SiteOtlpOptions): SiteOtlpResult {
  const days = opts.days ?? SITE_COPILOT_DAYS;
  const windowEnd = opts.anchorMs - END_MARGIN_MS;
  const calendar = siteCalendar(opts.anchorMs - days * DAY_MS, windowEnd);
  const placed = plan.conversations.flatMap((conversation) =>
    placeConversation(conversation, calendar(conversation.position), windowEnd).map((layout) => ({
      conversation,
      layout,
    })),
  );
  placed.sort(
    (a, b) => a.layout.start - b.layout.start || (a.layout.turn.key < b.layout.turn.key ? -1 : 1),
  );

  const writer = new BodyWriter();
  const chatSpans: SiteChatSpan[] = [];
  let spans = 0;
  let toolSpans = 0;
  for (const { conversation, layout } of placed) {
    const trace = traceSpans(plan.seed, conversation, layout);
    writer.add(trace.spans.map((span) => encodeSpan(trace.traceId, span)));
    chatSpans.push(...trace.chats);
    spans += trace.spans.length;
    toolSpans += layout.turn.calls.length;
  }
  writer.flush();
  return {
    batches: writer.bodies,
    chatSpans,
    window: {
      startMs: placed[0]?.layout.start ?? windowEnd,
      endMs: Math.max(...placed.map((p) => p.layout.end)),
    },
    stats: {
      traces: placed.length,
      spans,
      toolSpans,
      chatSpans: chatSpans.length,
      bodies: writer.bodies.length,
    },
  };
}
