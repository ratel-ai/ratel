/**
 * The Sessions tab's view state (DESIGN.md, Everything is a URL): the filter
 * in `?show=`, the specialist columns in `?columns=`, the open row in
 * `?peek=`; and how a row reads: its title and its day. Pure.
 */

import type { SessionRow, SessionsPage } from "./sessions";

export const SESSIONS_FILTERS = ["all", "failed"] as const;
export type SessionsFilter = (typeof SESSIONS_FILTERS)[number];

/** Columns hidden until toggled, in the order they show. */
export const SESSION_COLUMNS = ["tools", "tokens", "cost"] as const;
export type SessionColumn = (typeof SESSION_COLUMNS)[number];

export const SESSIONS_FILTER_PARAM = "show";
export const SESSION_COLUMNS_PARAM = "columns";

export const SESSIONS_FILTER_LABEL: Readonly<Record<SessionsFilter, string>> = {
  all: "All",
  failed: "Failed",
};
export const SESSION_COLUMN_LABEL: Readonly<Record<SessionColumn, string>> = {
  tools: "Tools",
  tokens: "Tokens",
  cost: "Cost",
};

/** A repeated or unknown value reads as its first known value, else All. */
export function parseSessionsFilter(
  value: string | readonly string[] | null | undefined,
): SessionsFilter {
  const first = typeof value === "string" ? value : value?.[0];
  return SESSIONS_FILTERS.find((filter) => filter === first) ?? "all";
}

export function sessionsFilterFrom(search: string): SessionsFilter {
  return parseSessionsFilter(parse(search).getAll(SESSIONS_FILTER_PARAM));
}

/** A new filter is a new list: the open row goes, the rest stays (the header's timeframe too). */
export function withSessionsFilter(search: string, filter: SessionsFilter): string {
  const params = parse(search);
  params.delete("peek");
  params.delete(SESSIONS_FILTER_PARAM);
  if (filter !== "all") params.set(SESSIONS_FILTER_PARAM, filter);
  return stringify(params);
}

export function sessionColumnsFrom(search: string): SessionColumn[] {
  const listed = new Set(
    (parse(search).get(SESSION_COLUMNS_PARAM) ?? "").split(",").map((value) => value.trim()),
  );
  return SESSION_COLUMNS.filter((column) => listed.has(column));
}

export function withSessionColumns(search: string, columns: readonly SessionColumn[]): string {
  const params = parse(search);
  const ordered = SESSION_COLUMNS.filter((column) => columns.includes(column));
  if (ordered.length > 0) params.set(SESSION_COLUMNS_PARAM, ordered.join(","));
  else params.delete(SESSION_COLUMNS_PARAM);
  return stringify(params);
}

/** The row's `?peek=` id: a session and a run can never share one. */
export function sessionRowKey(row: Pick<SessionRow, "kind" | "id">): string {
  return `${row.kind}:${row.id}`;
}

/** What the row reads as: the ask, else the intent (text off), else what it is. */
export function sessionTitle(row: Pick<SessionRow, "kind" | "id" | "ask" | "intent">): {
  text: string;
  source: "ask" | "intent" | "id";
} {
  const ask = row.ask?.replace(/\s+/g, " ").trim();
  if (ask) return { text: ask, source: "ask" };
  const intent = row.intent?.trim();
  if (intent) return { text: intent, source: "intent" };
  return {
    text: row.kind === "session" ? `Session ${row.id}` : `Run ${row.id.slice(0, 8)}`,
    source: "id",
  };
}

/** The list after the next page: its rows after the ones shown (a row already shown is not repeated), and its cursor. */
export function appendSessionsPage<Row extends Pick<SessionRow, "kind" | "id">>(
  shown: readonly Row[],
  page: { items: readonly Row[]; nextCursor: SessionsPage["nextCursor"] },
): { rows: Row[]; nextCursor: string | null } {
  const seen = new Set(shown.map(sessionRowKey));
  return {
    rows: [...shown, ...page.items.filter((row) => !seen.has(sessionRowKey(row)))],
    nextCursor: page.nextCursor,
  };
}

/**
 * Rows in list order, split where the day (in `timeZone`) changes. Each group
 * has its own key (its place and its day): pages that meet on the same day,
 * or a day that comes back, never repeat a key (review finding Runs F4).
 */
export function groupSessionsByDay<Row extends Pick<SessionRow, "lastActivityAt">>(
  rows: readonly Row[],
  timeZone = "UTC",
): { key: string; day: string; rows: Row[] }[] {
  const dayOf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const groups: { key: string; day: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const day = dayOf.format(new Date(row.lastActivityAt));
    const last = groups.at(-1);
    if (last?.day === day) last.rows.push(row);
    else groups.push({ key: `${groups.length}:${day}`, day, rows: [row] });
  }
  return groups;
}

function parse(search: string): URLSearchParams {
  return new URLSearchParams(search.replace(/^\?/, ""));
}

function stringify(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : "";
}
