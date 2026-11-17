import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendSessionsPage,
  groupSessionsByDay,
  parseSessionsFilter,
  sessionColumnsFrom,
  sessionRowKey,
  sessionsFilterFrom,
  sessionTitle,
  withSessionColumns,
  withSessionsFilter,
} from "./view";

/** RC-313: the Sessions tab's state lives in the URL; rows read as their ask and group by day. */

test("the filter reads from ?show=: All or Failed, no To check", () => {
  assert.equal(sessionsFilterFrom("?show=failed&window=24h"), "failed");
  assert.equal(sessionsFilterFrom("?show=to_check"), "all");
  assert.equal(
    sessionsFilterFrom("?show=failed&show=all"),
    "failed",
    "a repeated value reads as its first",
  );
  assert.equal(sessionsFilterFrom(""), "all");
  assert.equal(parseSessionsFilter(["failed"]), "failed");
});

test("changing the filter drops the open row and keeps the rest, the timeframe too", () => {
  assert.equal(
    withSessionsFilter("?window=24h&peek=session:x&columns=tools", "failed"),
    "?window=24h&columns=tools&show=failed",
  );
  assert.equal(withSessionsFilter("?show=failed", "all"), "");
});

test("tools, tokens and cost are hidden until the URL lists them, in a stable order", () => {
  assert.deepEqual(sessionColumnsFrom("?columns=cost,tools,experiment"), ["tools", "cost"]);
  assert.equal(
    withSessionColumns("?show=failed", ["cost", "tokens"]),
    "?show=failed&columns=tokens%2Ccost",
  );
  assert.equal(withSessionColumns("?columns=tools", []), "");
});

test("a row reads as its ask, else its intent, else what it is", () => {
  assert.deepEqual(
    sessionTitle({ kind: "session", id: "s1", ask: "  Where is\n my order? ", intent: "Orders" }),
    { text: "Where is my order?", source: "ask" },
  );
  assert.deepEqual(sessionTitle({ kind: "session", id: "s1", ask: null, intent: "Orders" }), {
    text: "Orders",
    source: "intent",
  });
  assert.deepEqual(sessionTitle({ kind: "session", id: "s1", ask: null, intent: null }), {
    text: "Session s1",
    source: "id",
  });
  assert.deepEqual(sessionTitle({ kind: "run", id: "abcdef0123456789", ask: "", intent: null }), {
    text: "Run abcdef01",
    source: "id",
  });
  assert.notEqual(
    sessionRowKey({ kind: "session", id: "x" }),
    sessionRowKey({ kind: "run", id: "x" }),
  );
});

test("groups follow the list order, and no two groups share a key, even when a day comes back", () => {
  const row = (lastActivityAt: string) => ({ lastActivityAt });
  const groups = groupSessionsByDay([
    row("2026-11-03T08:00:00Z"),
    row("2026-11-02T23:00:00Z"),
    row("2026-11-02T01:00:00Z"),
    row("2026-11-03T01:00:00Z"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.day, group.rows.length]),
    [
      ["2026-11-03", 1],
      ["2026-11-02", 2],
      ["2026-11-03", 1],
    ],
  );
  assert.equal(new Set(groups.map((group) => group.key)).size, groups.length);
  // In a time zone ahead of UTC, 23:00 UTC is already the next day.
  assert.deepEqual(
    groupSessionsByDay(
      [row("2026-11-03T08:00:00Z"), row("2026-11-02T23:00:00Z")],
      "Europe/Rome",
    ).map((group) => group.rows.length),
    [2],
  );
  assert.deepEqual(groupSessionsByDay([]), []);
});

test("Load more appends the next page after the rows shown, once each, and takes its cursor", () => {
  const row = (kind: "session" | "run", id: string) => ({ kind, id });
  const shown = [row("session", "a"), row("run", "b")];
  assert.deepEqual(
    appendSessionsPage(shown, {
      items: [row("run", "b"), row("session", "c")],
      nextCursor: "next",
    }),
    {
      rows: [row("session", "a"), row("run", "b"), row("session", "c")],
      nextCursor: "next",
    },
  );
  assert.deepEqual(appendSessionsPage(shown, { items: [], nextCursor: null }), {
    rows: shown,
    nextCursor: null,
  });
});
