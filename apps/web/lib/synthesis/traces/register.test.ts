import assert from "node:assert/strict";
import { test } from "node:test";
import { runDrainTick } from "@/lib/jobs/drain";
import type { BackgroundObservabilityDeps } from "@/lib/jobs/observability";
import { refreshStep, retentionSteps, tracesRegistration } from "./register";
import type { TraceSummaryRefreshResult } from "./summary-refresh";

const result = (spansScanned: number): TraceSummaryRefreshResult => ({
  spansScanned,
  tracesRecomputed: spansScanned ? 2 : 0,
  batches: spansScanned ? 1 : 0,
  caughtUp: true,
  lockContended: false,
});

test("traces register the refresh between upstream's retention prunes, and no job", () => {
  assert.deepEqual(Object.keys(tracesRegistration.jobs ?? {}), []);
  assert.deepEqual(
    (tracesRegistration.drainSteps ?? []).map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [
      ["otel_spans_prune", "after", true],
      ["otel_logs_prune", "after", true],
      ["trace_summary_refresh", "after", false],
      ["trace_summary_prune", "after", true],
    ],
  );
});

/** One tick over the traces steps with counting prunes; returns the call order and the heartbeat. */
async function tick(retentionEnabled: boolean) {
  const calls: string[] = [];
  const heartbeats: Record<string, unknown>[] = [];
  const observability: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, _context, properties) => {
      if (event === "cron_drain_completed") heartbeats.push(properties ?? {});
    },
    reportServerException: () => {},
    now: () => 0,
    logError: () => {},
  };
  const prune = (name: string, deleted: number) => async () => {
    calls.push(name);
    return deleted;
  };
  const { spans, logs, summaries } = retentionSteps({
    pruneExpiredOtelSpans: prune("spans", 14),
    pruneExpiredOtelLogs: prune("logs", 15),
    pruneExpiredTraceSummaries: prune("summaries", 20),
  });
  const refresh = refreshStep(
    async () => {
      calls.push("refresh");
      return result(0);
    },
    async () => {},
  );
  const summary = await runDrainTick({
    steps: [spans, logs, refresh, summaries],
    drainProjectJobs: async () => ({ done: 0, failed: 0 }),
    retentionEnabled,
    observability,
  });
  return { calls, heartbeat: heartbeats[0] ?? {}, summary };
}

test("with retention on, a tick prunes spans and logs before the refresh and summaries after it", async () => {
  const { calls, heartbeat } = await tick(true);
  assert.deepEqual(calls, ["spans", "logs", "refresh", "summaries"]);
  assert.equal(heartbeat.otelSpansPruned, 14);
  assert.equal(heartbeat.otelLogsPruned, 15);
  assert.equal(heartbeat.traceSummariesPruned, 20);
});

test("with retention off, a tick deletes nothing and still refreshes", async () => {
  const { calls, heartbeat, summary } = await tick(false);
  assert.deepEqual(calls, ["refresh"]);
  assert.equal(heartbeat.otelSpansPruned, undefined);
  assert.equal(heartbeat.otelLogsPruned, undefined);
  assert.equal(heartbeat.traceSummariesPruned, undefined);
  assert.deepEqual(
    [
      summary.steps.otel_spans_prune,
      summary.steps.otel_logs_prune,
      summary.steps.trace_summary_prune,
    ],
    ["skipped", "skipped", "skipped"],
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
