import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshStep, tracesRegistration } from "./register";
import type { TraceSummaryRefreshResult } from "./summary-refresh";

const result = (spansScanned: number): TraceSummaryRefreshResult => ({
  spansScanned,
  tracesRecomputed: spansScanned ? 2 : 0,
  batches: spansScanned ? 1 : 0,
  caughtUp: true,
  lockContended: false,
});

test("traces register one after-step and no job", () => {
  assert.deepEqual(Object.keys(tracesRegistration.jobs ?? {}), []);
  assert.deepEqual(
    (tracesRegistration.drainSteps ?? []).map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [["trace_summary_refresh", "after", false]],
  );
});

test("the refresh step reports under upstream's heartbeat keys and emits its event when it did work", async () => {
  const events: unknown[] = [];
  const step = refreshStep(
    async () => result(10),
    async (...args) => {
      events.push(args);
    },
  );
  assert.deepEqual(await step.run(), {
    traceSummarySpansScanned: 10,
    traceSummariesRecomputed: 2,
    traceSummariesCaughtUp: true,
  });
  assert.deepEqual(events, [
    [
      "trace_summaries_refreshed",
      "system:cron",
      {
        spans_scanned: 10,
        traces_recomputed: 2,
        batches: 1,
        caught_up: true,
        lock_contended: false,
      },
    ],
  ]);
});

test("an idle refresh emits nothing", async () => {
  const events: unknown[] = [];
  await refreshStep(
    async () => result(0),
    async (...args) => {
      events.push(args);
    },
  ).run();
  assert.deepEqual(events, []);
});
