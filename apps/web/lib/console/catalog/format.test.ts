import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtCompact, fmtDateTime, fmtDay, fmtExact, fmtMoney, fmtRelative, plural } from "./format";

test("stats abbreviate and tables stay exact", () => {
  assert.equal(fmtCompact(45), "45");
  assert.equal(fmtCompact(1284), "1.3K");
  assert.equal(fmtCompact(12_400), "12.4K");
  assert.equal(fmtCompact(Number.NaN), "0");
  assert.equal(fmtExact(1284), "1,284");
});

test("money always has two decimals and never shows a fraction of a cent", () => {
  assert.equal(fmtMoney(0), "$0.00");
  assert.equal(fmtMoney(0.0049), "<$0.01");
  assert.equal(fmtMoney(1204.5), "$1,204.50");
  assert.equal(fmtMoney(0.1), "$0.10");
});

test("times are UTC, absolute in details and relative in lists", () => {
  assert.equal(fmtDay("2026-10-09T23:59:00Z"), "Oct 9, 2026");
  assert.equal(fmtDateTime("2026-10-09T12:23:35Z"), "Oct 9, 2026, 12:23 UTC");
  assert.equal(
    fmtDateTime("2026-10-09T00:05:00Z"),
    "Oct 9, 2026, 00:05 UTC",
    "midnight is 00, never 24",
  );
  const now = "2026-10-15T12:00:00Z";
  assert.equal(fmtRelative("2026-10-15T11:59:30Z", now), "just now");
  assert.equal(fmtRelative("2026-10-15T11:55:00Z", now), "5 min ago");
  assert.equal(fmtRelative("2026-10-15T09:00:00Z", now), "3 h ago");
  assert.equal(fmtRelative("2026-10-14T09:00:00Z", now), "yesterday");
  assert.equal(fmtRelative("2026-10-09T12:00:00Z", now), "6 days ago");
  assert.equal(fmtRelative("2026-08-01T12:00:00Z", now), "Aug 1, 2026");
  assert.equal(
    fmtRelative("2026-10-16T12:00:00Z", now),
    "just now",
    "a clock ahead of the server is not the future",
  );
});

test("counts carry their noun", () => {
  assert.equal(plural(1, "tool"), "1 tool");
  assert.equal(plural(97, "tool"), "97 tools");
  assert.equal(plural(2, "match", "matches"), "2 matches");
});
