import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCompact,
  formatDay,
  formatDayRange,
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
  MISSING,
  NBSP,
  shortId,
} from "./format";

const plain = (text: string) => text.replaceAll(NBSP, " ");

test("durations carry their unit after a non-breaking space and carry over at unit edges", () => {
  assert.equal(formatDuration(0), `0${NBSP}ms`);
  assert.equal(plain(formatDuration(0.42)), "0.42 ms");
  assert.equal(plain(formatDuration(4.25)), "4.3 ms");
  assert.equal(plain(formatDuration(120.4)), "120 ms");
  assert.equal(plain(formatDuration(999.6)), "1 s", "999.6 ms rounds into seconds, not 1000 ms");
  assert.equal(plain(formatDuration(1240)), "1.2 s");
  assert.equal(plain(formatDuration(48_200)), "48 s");
  assert.equal(plain(formatDuration(59_700)), "1 min", "59.7 s carries into a minute");
  assert.equal(plain(formatDuration(125_000)), "2 min 5 s");
  assert.equal(plain(formatDuration(3_900_000)), "1 h 5 min");
  assert.equal(formatDuration(Number.NaN), MISSING);
  assert.equal(formatDuration(null), MISSING);
  assert.equal(formatDuration(-1), MISSING);
});

test("stats abbreviate, tables stay exact", () => {
  assert.equal(formatInteger(12431), "12,431");
  assert.equal(formatCompact(1284), "1,284");
  assert.equal(formatCompact(12_400), "12.4K");
  assert.equal(formatCompact(100_000), "100K");
  assert.equal(formatCompact(999_960), "1M", "rounding up to 1000K moves to the next unit");
  assert.equal(formatCompact(3_140_000), "3.1M");
  assert.equal(formatCompact(Number.POSITIVE_INFINITY), MISSING);
});

test("money always has two decimals, and a sub-cent amount never reads as free", () => {
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(0.0012), "<$0.01");
  assert.equal(formatMoney(3.2), "$3.20");
  assert.equal(formatMoney("9.372753"), "$9.37");
  assert.equal(formatMoney(1234.5), "$1,234.50");
  assert.equal(formatMoney(null), MISSING);
});

test("rates read as percentages with one decimal under ten", () => {
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.0004), "<0.1%");
  assert.equal(formatPercent(0.034), "3.4%");
  assert.equal(formatPercent(0.05), "5%");
  assert.equal(formatPercent(0.1234), "12%");
  assert.equal(formatPercent(1), "100%");
});

test("days and timestamps are UTC and built without Intl, so server and browser agree", () => {
  assert.equal(formatDay("2026-10-09"), "Oct 9");
  assert.equal(formatDayRange("2026-10-09", "2026-10-09"), "Oct 9");
  assert.equal(formatDayRange("2026-10-09", "2026-10-11"), "Oct 9 to Oct 11");
  assert.equal(
    formatDayRange("2026-10-09", "2026-10-11", "2026-10-18"),
    "Oct 9 to Oct 11",
    "this year needs no year",
  );
  assert.equal(
    formatDayRange("2025-01-01", "2025-01-07", "2026-10-18"),
    "Jan 1, 2025 to Jan 7, 2025",
  );
  assert.equal(plain(formatTimestamp("2026-10-09T12:00:35.578Z")), "Oct 9, 2026, 12:00:35 UTC");
  assert.equal(formatTimestamp("not a date"), MISSING);
});

test("relative times count up from the request's now and fall back to a date after a week", () => {
  const now = "2026-10-15T12:00:00.000Z";
  assert.equal(formatRelativeTime("2026-10-15T11:59:40.000Z", now), "just now");
  assert.equal(plain(formatRelativeTime("2026-10-15T11:57:00.000Z", now)), "3 min ago");
  assert.equal(plain(formatRelativeTime("2026-10-15T07:00:00.000Z", now)), "5 h ago");
  assert.equal(formatRelativeTime("2026-10-14T10:00:00.000Z", now), "yesterday");
  assert.equal(plain(formatRelativeTime("2026-10-09T12:00:35.578Z", now)), "6 days ago");
  assert.equal(formatRelativeTime("2026-09-02T09:16:51.776Z", now), "Sep 2");
  assert.equal(formatRelativeTime("2025-09-02T09:16:51.776Z", now), "Sep 2, 2025");
});

test("ids are shortened in the middle and short ids are left alone", () => {
  assert.equal(shortId("f7a19d4e000000000000000000000004"), "f7a19d4e…0004");
  assert.equal(shortId("abc"), "abc");
});
