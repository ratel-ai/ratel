import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBytes,
  formatDay,
  formatDuration,
  formatLongDay,
  formatStamp,
  NBSP,
  relativeTime,
} from "@/lib/console/settings/format";

test("days read in UTC, so a late-evening expiry is the day it was set for", () => {
  assert.equal(formatDay("2026-10-22T23:30:00.000Z"), "Oct 22, 2026");
  assert.equal(formatDay(new Date("2026-01-01T00:00:00.000Z")), "Jan 1, 2026");
  assert.equal(formatLongDay("2026-11-03T08:00:00.000Z"), "November 3, 2026");
  assert.equal(formatStamp("2026-10-18T12:20:27.000Z"), "Oct 18, 2026, 12:20:27 UTC");
});

test("relative times use Overview's words", () => {
  const now = new Date("2026-10-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(relativeTime(ago(20_000), now), "just now");
  assert.equal(relativeTime(ago(5 * 60_000), now), "5m ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), now), "3h ago");
  assert.equal(relativeTime(ago(3 * 86_400_000), now), "3d ago");
  assert.equal(relativeTime(ago(90 * 86_400_000), now), "3mo ago");
  assert.equal(
    relativeTime(ago(-60_000), now),
    "just now",
    "a clock skew into the future is not negative",
  );
});

test("a number never wraps away from its unit", () => {
  assert.equal(formatBytes(320), `320${NBSP}B`);
  assert.equal(formatBytes(1536), `1.5${NBSP}KB`);
  assert.equal(formatBytes(3 * 1024 * 1024), `3.0${NBSP}MB`);
  assert.equal(formatDuration(42), `42${NBSP}ms`);
  assert.equal(formatDuration(1200), `1.2${NBSP}s`);
});
