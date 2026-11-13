import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RUN_WINDOW_DAYS,
  isRunWindowSupported,
  MAX_RUN_WINDOW_DAYS,
  nextBillingPeriodStart,
  parseRunWindowDays,
  resolveRunWindow,
  startOfBillingPeriod,
  windowSinceLastChange,
} from "./window";

const NOW = new Date("2026-09-14T12:00:00Z");

test("a window request is clamped to the telemetry retention wall", () => {
  assert.equal(parseRunWindowDays(90), MAX_RUN_WINDOW_DAYS);
  assert.equal(parseRunWindowDays(0), 1);
  assert.equal(parseRunWindowDays(-5), 1);
  assert.equal(parseRunWindowDays("14"), 14);
  assert.equal(parseRunWindowDays(undefined), DEFAULT_RUN_WINDOW_DAYS);
  assert.equal(parseRunWindowDays("nonsense"), DEFAULT_RUN_WINDOW_DAYS);
});

test("the meter's 90-day option is not a supported run window", () => {
  assert.equal(isRunWindowSupported(30), true);
  assert.equal(isRunWindowSupported(90), false);
});

test("a scheduled window reaches back to the last applied change", () => {
  const lastChange = new Date("2026-08-31T12:00:00Z"); // 14 days before NOW
  assert.equal(windowSinceLastChange(lastChange, NOW), 14);
});

test("a change more recent than the default does not shrink the window", () => {
  const yesterday = new Date("2026-09-13T12:00:00Z");
  assert.equal(windowSinceLastChange(yesterday, NOW), DEFAULT_RUN_WINDOW_DAYS);
});

test("a corpus untouched for months still reads a window that exists", () => {
  const ages = new Date("2026-01-01T00:00:00Z");
  assert.equal(windowSinceLastChange(ages, NOW), MAX_RUN_WINDOW_DAYS);
});

test("no recorded change falls back to the default week", () => {
  assert.equal(windowSinceLastChange(null, NOW), DEFAULT_RUN_WINDOW_DAYS);
});

test("resolving a window gives skew headroom on the upper bound", () => {
  const window = resolveRunWindow(7, NOW);
  assert.equal(window.since.toISOString(), "2026-09-07T12:00:00.000Z");
  assert.ok(window.until.getTime() > NOW.getTime());
  assert.equal(window.until.getTime() - NOW.getTime(), 60 * 1000);
});

test("the billing period anchor is the first instant of the UTC month", () => {
  assert.equal(
    startOfBillingPeriod(new Date("2026-09-14T12:00:00Z")).toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
  // A local-time implementation would land on 31 December for this one.
  assert.equal(
    startOfBillingPeriod(new Date("2026-01-01T00:30:00Z")).toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
});

test("the budget's reset date is the first of next month, and rolls the year", () => {
  assert.equal(
    nextBillingPeriodStart(new Date("2026-09-14T12:00:00Z")).toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(
    nextBillingPeriodStart(new Date("2026-12-31T23:59:00Z")).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});
