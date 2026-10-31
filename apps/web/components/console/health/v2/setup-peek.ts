import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";

/**
 * The setup guides open in a Panel on the Summary (`?peek=setup:<key>`), from
 * the setup callout's chips and from the sections that need a data point:
 * one guide per data point, and one for content capture on readings stored
 * before setup facts. Pure, client-safe.
 */

export const SETUP_PEEK_PREFIX = "setup:";

/** The guide for content capture (and the OpenTelemetry options) on older readings. */
export const CAPTURE_GUIDE = "capture";

export type SetupGuideKey = SetupKey | typeof CAPTURE_GUIDE;

export function setupPeek(key: SetupGuideKey): string {
  return `${SETUP_PEEK_PREFIX}${key}`;
}

/** Every data point a guide exists for. */
const SETUP_KEYS: ReadonlySet<string> = new Set<SetupKey>([
  "otel_tool_spans",
  "otel_model_calls",
  "otel_conversation_id",
  "otel_user_id",
  "otel_content",
  "otel_tool_definitions",
  "otel_trace_context",
  "sdk_tool_calls",
  "sdk_search_queries",
  "sdk_turn_ids",
  "sdk_user_messages",
  "sdk_end_users",
  "both_linked",
]);

/** The guide a `?peek=` names, or null for another panel's (and for a key no guide exists for). */
export function peekedSetup(peek: string | null): SetupGuideKey | null {
  if (!peek?.startsWith(SETUP_PEEK_PREFIX)) return null;
  const key = peek.slice(SETUP_PEEK_PREFIX.length);
  if (key === CAPTURE_GUIDE) return CAPTURE_GUIDE;
  return SETUP_KEYS.has(key) ? (key as SetupKey) : null;
}
