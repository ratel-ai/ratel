import type { getDb } from "@/lib/platform/db/client";
import type { TraceQueriesDb } from "@/lib/synthesis/traces/queries";

/**
 * The Sessions list's paging (`listSessionList` in lib/traces/v2/sessions-list.ts):
 * a page reads newest activity first and the next page starts after its last
 * row. There is no timeframe, so a page walk is bounded by its LIMIT, however
 * old the project.
 */

/** Where the next page starts: the last row's activity (UTC, microseconds) and id. */
export interface SessionsCursor {
  at: string;
  id: string;
}

/** The trace reads plus raw SQL, for the page walk. */
export type SessionsDb = TraceQueriesDb & Pick<ReturnType<typeof getDb>, "execute">;

export function encodeSessionsCursor(cursor: SessionsCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** The cursor, or null (the first page) when it is missing or malformed. */
export function decodeSessionsCursor(value: string | null | undefined): SessionsCursor | null {
  if (!value) return null;
  const text = Buffer.from(value, "base64url").toString("utf8");
  const split = text.indexOf("|");
  if (split < 0) return null;
  const at = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) || !id) return null;
  return { at, id };
}
