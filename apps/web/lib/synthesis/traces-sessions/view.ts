/**
 * The Sessions tab's filter (DESIGN.md, Everything is a URL): All or Failed,
 * in `?show=`. Pure.
 */

export const SESSIONS_FILTERS = ["all", "failed"] as const;
export type SessionsFilter = (typeof SESSIONS_FILTERS)[number];

export const SESSIONS_FILTER_PARAM = "show";

export const SESSIONS_FILTER_LABEL: Readonly<Record<SessionsFilter, string>> = {
  all: "All",
  failed: "Failed",
};

/**
 * Why the Sessions list is empty (RC-752): nothing sent yet, events but no
 * traces, turns but none in a session, nothing matching the filters, or no
 * failed session.
 */
export type SessionsEmptyKind =
  | "no-telemetry"
  | "events-only"
  | "no-sessions"
  | "filtered"
  | "no-failed";

/** The span attribute that puts turns in one session (`lib/otlp/attr-resolve.ts` reads it first). */
export const SESSION_ID_ATTRIBUTE = "gen_ai.conversation.id";

/** What "Copy prompt for your coding agent" copies. */
export const SESSION_ID_PROMPT = [
  "Group the OpenTelemetry spans of this agent into sessions.",
  `Set the span attribute ${SESSION_ID_ATTRIBUTE} on every span of one conversation: the agent run, each model call and each tool call.`,
  "Use one stable id for one conversation, for example the chat thread id or the MCP session id. Use a new id for a new conversation.",
  "Do not put user data in the id. Do not change other attributes.",
].join("\n");

/** A repeated or unknown value reads as its first known value, else All. */
export function parseSessionsFilter(
  value: string | readonly string[] | null | undefined,
): SessionsFilter {
  const first = typeof value === "string" ? value : value?.[0];
  return SESSIONS_FILTERS.find((filter) => filter === first) ?? "all";
}

/** A new filter is a new list: the open row goes, the rest stays (the header's timeframe too). */
export function withSessionsFilter(search: string, filter: SessionsFilter): string {
  const params = parse(search);
  params.delete("peek");
  params.delete(SESSIONS_FILTER_PARAM);
  if (filter !== "all") params.set(SESSIONS_FILTER_PARAM, filter);
  return stringify(params);
}

/** The empty state of an empty first page. Pure: the page reads the inputs. */
export function sessionsEmptyKind({
  filter,
  filtered,
  hasEvents,
  hasSpans,
}: {
  filter: SessionsFilter;
  /** Property filters are set. */
  filtered: boolean;
  hasEvents: boolean;
  hasSpans: boolean;
}): SessionsEmptyKind {
  if (filtered) return "filtered";
  if (filter === "failed") return "no-failed";
  if (hasSpans) return "no-sessions";
  return hasEvents ? "events-only" : "no-telemetry";
}

function parse(search: string): URLSearchParams {
  return new URLSearchParams(search.replace(/^\?/, ""));
}

function stringify(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : "";
}
