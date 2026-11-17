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

function parse(search: string): URLSearchParams {
  return new URLSearchParams(search.replace(/^\?/, ""));
}

function stringify(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : "";
}
