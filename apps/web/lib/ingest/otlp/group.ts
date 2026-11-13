import { attrString } from "./anyvalue";
import {
  EXECUTE_TOOL,
  GEN_AI,
  GEN_AI_INFERENCE_DETAILS,
  LLM_OPERATIONS,
  NON_ROUND_TRIP_OPERATIONS,
  USAGE_PREFIX,
} from "./constants";
import type { DecodedSpan, GroupedCall } from "./types";

/**
 * Flag `cloud-otlp-agent-span-dedupe` on: the traces known to hold a model
 * call, in this batch or already stored. An agent wrapper span in one of them
 * is not a call (see {@link isDedupedAgentSpan}). Absent = flag off.
 */
export interface AgentSpanDedupe {
  modelCallTraces: ReadonlySet<string>;
}

/**
 * Fold a flat span list into per-LLM-call groups.
 *
 * Each `gen_ai` client span becomes one {@link GroupedCall} (→ one CloudEvent).
 * Its content-bearing inference-details event (opt-in) and the sibling
 * `execute_tool` spans from the same trace are attached to it, so the mapper can
 * reconstruct tools_used even when message content wasn't captured. Grouping keys
 * on `(traceId, spanId)` only, so an export batch spanning several traces or
 * carrying several calls stays cleanly separated.
 */

/** An `execute_tool` span — a tool-invocation signal, never an LLM-call anchor. */
export function isExecuteTool(span: DecodedSpan): boolean {
  return (
    attrString(span.attributes, GEN_AI.operationName) === EXECUTE_TOOL || span.name === EXECUTE_TOOL
  );
}

/** A `gen_ai` LLM-call span: a known operation, or any span reporting usage/model. */
export function isAnchor(span: DecodedSpan): boolean {
  const op = attrString(span.attributes, GEN_AI.operationName);
  if (op === EXECUTE_TOOL) return false;
  if (op && LLM_OPERATIONS.has(op)) return true;
  // Fallback for instrumentations that omit operation.name: a non-ratel span that
  // reports a request model or any token usage is an LLM call.
  if (span.name.startsWith("ratel.")) return false;
  if (attrString(span.attributes, GEN_AI.requestModel) !== undefined) return true;
  return Object.keys(span.attributes).some((k) => k.startsWith(USAGE_PREFIX));
}

/**
 * An agent-level wrapper (`invoke_agent` and friends, not `embeddings`). It
 * often carries the run's model and summed usage (LangGraph custom emitters,
 * Claude Agent SDK, AI SDK 7, Mastra), so the usage fallback in `isAnchor`
 * reads it as one more call.
 */
export function isAgentWrapper(span: DecodedSpan): boolean {
  const op = attrString(span.attributes, GEN_AI.operationName);
  return !!op && NON_ROUND_TRIP_OPERATIONS.has(op) && !LLM_OPERATIONS.has(op);
}

/**
 * A model-call span: an anchor that is one model round trip, so not an agent
 * wrapper and not `embeddings`. An embeddings span stays an anchor, but it
 * neither dedupes a wrapper's chat usage nor owns a wrapper's tools.
 */
export function isModelCall(span: DecodedSpan): boolean {
  const op = attrString(span.attributes, GEN_AI.operationName);
  return !isExecuteTool(span) && isAnchor(span) && !(op && NON_ROUND_TRIP_OPERATIONS.has(op));
}

/** The traces in `spans` that hold at least one model-call span. */
export function modelCallTraceIds(spans: DecodedSpan[]): Set<string> {
  return new Set(spans.filter(isModelCall).map((s) => s.traceId));
}

/**
 * An agent wrapper whose trace has its own model calls: counting it too would
 * count the run's usage twice. With no model call in the trace, the wrapper is
 * the only record of the run and stays a call.
 */
export function isDedupedAgentSpan(span: DecodedSpan, dedupe?: AgentSpanDedupe): boolean {
  return !!dedupe && isAgentWrapper(span) && dedupe.modelCallTraces.has(span.traceId);
}

/**
 * Walk a tool span up to the anchor that owns it, else the trace's sole anchor.
 * A chain through a deduped agent wrapper (`isDeduped`, flag on only) falls to
 * the trace's model call that started last at or before the tool.
 */
function findOwningAnchor(
  tool: DecodedSpan,
  byId: Map<string, DecodedSpan>,
  isAnchorSpan: (id: string) => boolean,
  isDeduped: (span: DecodedSpan) => boolean,
  anchorsByTrace: Map<string, DecodedSpan[]>,
): DecodedSpan | null {
  const seen = new Set<string>();
  let underDedupedWrapper = false;
  let cur: DecodedSpan | undefined = tool;
  while (cur) {
    if (seen.has(cur.spanId)) break; // cycle guard
    seen.add(cur.spanId);
    const parentId = cur.parentSpanId;
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    if (isAnchorSpan(parent.spanId)) return parent;
    if (isDeduped(parent)) underDedupedWrapper = true;
    cur = parent;
  }
  const inTrace = anchorsByTrace.get(tool.traceId) ?? [];
  if (underDedupedWrapper) return precedingModelCall(tool, inTrace);
  // No anchor on the parent chain: if the trace has exactly one, it owns the tool.
  return inTrace.length === 1 ? inTrace[0] : null;
}

export function groupSpans(spans: DecodedSpan[], dedupe?: AgentSpanDedupe): GroupedCall[] {
  const byId = new Map<string, DecodedSpan>();
  for (const s of spans) if (s.spanId) byId.set(s.spanId, s);

  const anchors: DecodedSpan[] = [];
  const tools: DecodedSpan[] = [];
  for (const s of spans) {
    if (isExecuteTool(s)) tools.push(s);
    else if (isAnchor(s) && !isDedupedAgentSpan(s, dedupe)) anchors.push(s);
  }

  const anchorsByTrace = new Map<string, DecodedSpan[]>();
  const calls = new Map<string, GroupedCall>();
  const order: GroupedCall[] = [];
  for (const a of anchors) {
    const list = anchorsByTrace.get(a.traceId) ?? [];
    list.push(a);
    anchorsByTrace.set(a.traceId, list);

    const call: GroupedCall = {
      anchor: a,
      detailsEvent: a.events.find((e) => e.name === GEN_AI_INFERENCE_DETAILS) ?? null,
      toolSpans: [],
    };
    calls.set(a.spanId, call);
    order.push(call);
  }

  const isAnchorSpan = (id: string) => calls.has(id);
  const isDeduped = (span: DecodedSpan) => isDedupedAgentSpan(span, dedupe);
  for (const t of tools) {
    const owner = findOwningAnchor(t, byId, isAnchorSpan, isDeduped, anchorsByTrace);
    if (owner) calls.get(owner.spanId)!.toolSpans.push(t);
  }

  return order;
}

/**
 * The model call in `anchors` that started last at or before `tool` (ties keep
 * the first listed), else the earliest one. Null when `anchors` holds none.
 */
function precedingModelCall(tool: DecodedSpan, anchors: DecodedSpan[]): DecodedSpan | null {
  const modelCalls = anchors.filter(isModelCall);
  let preceding: DecodedSpan | null = null;
  let earliest: DecodedSpan | null = null;
  for (const a of modelCalls) {
    if (!earliest || a.startUnixMs < earliest.startUnixMs) earliest = a;
    if (a.startUnixMs > tool.startUnixMs) continue;
    if (!preceding || a.startUnixMs > preceding.startUnixMs) preceding = a;
  }
  return preceding ?? earliest;
}
