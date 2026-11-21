import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisPending,
  describeFreshness,
  IDLE_POLL_MS,
  minutesAgo,
  pendingPollMs,
  shouldRefresh,
} from "./model";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

test("ages read in plain words", () => {
  assert.equal(minutesAgo(ago(0.2), NOW), "just now");
  assert.equal(minutesAgo(ago(3), NOW), "3 min ago");
  assert.equal(minutesAgo(ago(125), NOW), "2 h ago");
  assert.equal(minutesAgo(ago(60 * 30), NOW), "yesterday");
  assert.equal(minutesAgo(ago(60 * 24 * 4), NOW), "4 days ago");
});

test("idle: when the analysis last updated", () => {
  assert.deepEqual(
    describeFreshness({ updatedAt: ago(3), working: false, importing: null }, NOW)?.text,
    "Analysis updated 3 min ago",
  );
  assert.equal(
    describeFreshness({ updatedAt: ago(3), working: false, importing: null }, NOW)?.state,
    "idle",
  );
});

test("working: says it is updating, with the age of what is shown", () => {
  const line = describeFreshness({ updatedAt: ago(4), working: true, importing: null }, NOW);
  assert.equal(line?.text, "Updating, last 4 min ago");
  assert.equal(line?.state, "working");
  assert.equal(
    describeFreshness({ updatedAt: null, working: true, importing: null }, NOW)?.text,
    "Analyzing your data",
  );
});

test("an import in progress wins, with the runs stored so far", () => {
  assert.equal(
    describeFreshness({ updatedAt: ago(4), working: true, importing: { runsImported: 1240 } }, NOW)
      ?.text,
    "Importing history: 1,240 runs",
  );
  assert.equal(
    describeFreshness({ updatedAt: null, working: false, importing: { runsImported: 0 } }, NOW)
      ?.text,
    "Importing your history",
  );
});

test("nothing analyzed and nothing running: no line at all", () => {
  assert.equal(describeFreshness({ updatedAt: null, working: false, importing: null }, NOW), null);
});

test("a page's poll backs off while its work runs, and waits a minute when idle", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map(pendingPollMs),
    [5_000, 7_500, 11_250, 16_875, 25_313, 30_000, 30_000],
  );
  assert.equal(IDLE_POLL_MS, 60_000);
});

test("a page reads itself again when its work finishes or a newer result lands", () => {
  const idle = { lastDoneAt: ago(10), pending: 0 };
  const working = { lastDoneAt: ago(10), pending: 2 };
  assert.equal(shouldRefresh(null, working), false, "the first read only seeds");
  assert.equal(shouldRefresh(working, working), false);
  assert.equal(shouldRefresh(idle, idle), false);
  assert.equal(shouldRefresh(working, idle), true, "work finished");
  assert.equal(shouldRefresh(working, { lastDoneAt: ago(10), pending: 0 }), true);
  assert.equal(
    shouldRefresh(idle, { lastDoneAt: ago(1), pending: 0 }),
    true,
    "a job ran between two polls",
  );
  assert.equal(
    shouldRefresh({ lastDoneAt: null, pending: 0 }, { lastDoneAt: null, pending: 0 }),
    false,
  );
});

test("a page is pending only while its jobs are queued or running", () => {
  assert.equal(analysisPending(null), false);
  assert.equal(analysisPending({ lastDoneAt: null, pending: 0 }), false);
  assert.equal(analysisPending({ lastDoneAt: null, pending: 1 }), true);
});
