import { attrString } from "./anyvalue";
import type { AttrMap, AttrValue, DecodedSpan } from "./types";

/**
 * Priority-ordered attribute reads across the OTel dialects a customer's agent
 * may emit (GenAI semconv, OpenInference, OpenLLMetry, LangSmith, the Vercel AI
 * SDK, MCP). One concept, such as "the conversation this span belongs to", has a
 * different key in each; these helpers read the first key that is present.
 *
 * Session and user ids are often set once, on the root span or the resource,
 * so {@link resolveUp} walks span, then its ancestors in the same export, then
 * the resource. Ancestors exported in a later batch are not visible here.
 */

/** The first non-empty string among `keys` on one attribute map. */
export function firstString(map: AttrMap, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attrString(map, key)?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Index a batch's spans by span id, for ancestor walks. */
export function indexSpans(spans: readonly DecodedSpan[]): ReadonlyMap<string, DecodedSpan> {
  const byId = new Map<string, DecodedSpan>();
  for (const span of spans) if (span.spanId) byId.set(span.spanId, span);
  return byId;
}

/** The span's ancestors in this export, nearest first. Cycle-safe. */
export function ancestorsOf(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
): DecodedSpan[] {
  const out: DecodedSpan[] = [];
  const seen = new Set<string>([span.spanId]);
  let parentId = span.parentSpanId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentSpanId;
  }
  return out;
}

/** The first of `keys` found on the span, then its ancestors, then its resource. */
export function resolveUp(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
  keys: readonly string[],
): string | undefined {
  const own = firstString(span.attributes, keys);
  if (own) return own;
  for (const ancestor of ancestorsOf(span, byId)) {
    const found = firstString(ancestor.attributes, keys);
    if (found) return found;
  }
  return firstString(span.resourceAttributes, keys);
}

/** A JSON-encoded string attribute parsed, or the structured value as-is. */
export function parsedValue(value: AttrValue | undefined): unknown {
  if (typeof value !== "string") return value ?? undefined;
  const trimmed = value.trim();
  if (!trimmed || !'[{"'.includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Conversation / session id keys, in priority order. `ai.settings.context.*`
 * is the AI SDK 7 runtime context (its `metadata` is gone), and
 * `traceloop.association.properties.*` is OpenLLMetry's
 * `set_association_properties`.
 */
export const SESSION_KEYS = [
  "gen_ai.conversation.id",
  "session.id",
  "langfuse.session.id",
  "ai.telemetry.metadata.sessionId",
  "ai.settings.context.sessionId",
  "traceloop.association.properties.session_id",
  "mastra.metadata.sessionId",
  "gcp.vertex.agent.session_id",
] as const;

/**
 * The MCP transport session, read only when no conversation id is found
 * anywhere up the span: one client connection, so a coarser grouping than a
 * conversation, but the only one an MCP server sees.
 */
export const MCP_SESSION_KEYS = ["mcp.session.id"] as const;

/** End-user id keys, in priority order. Mastra's resource id is its user. */
export const USER_KEYS = [
  "user.id",
  "enduser.id",
  "langfuse.user.id",
  "ai.telemetry.metadata.userId",
  "ai.settings.context.userId",
  "traceloop.association.properties.user_id",
  "mastra.metadata.userId",
  "mastra.metadata.resourceId",
] as const;

/** Agent-name keys, in priority order. */
export const AGENT_KEYS = ["gen_ai.agent.name", "gen_ai.agent.id", "agent.name"] as const;
