import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import type { DrainStep } from "@/lib/contracts/registry";
import { type DrainCronDeps, dataRetentionEnabled, runDrainTick } from "./drain";
import type { BackgroundObservabilityDeps } from "./observability";

/** The settings `env` resolves to (`web/src/config.ts`). */
const config = (env: Record<string, string> = {}) => resolveConfig({ env });

function observability() {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  const captures: Array<{
    error: unknown;
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  const logs: unknown[][] = [];
  let now = 1_000;
  const deps: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    reportServerException: (error, distinctId, properties) => {
      captures.push({ error, distinctId, properties });
    },
    now: () => (now += 10),
    logError: (...args) => logs.push(args),
  };
  return { deps, events, captures, logs };
}

function step(
  name: string,
  phase: DrainStep["phase"],
  run: DrainStep["run"],
  retentionOnly?: boolean,
): DrainStep {
  return { name, phase, run, ...(retentionOnly ? { retentionOnly } : {}) };
}

function tick(order: string[], overrides: Partial<DrainCronDeps> = {}): DrainCronDeps {
  return {
    steps: [
      step("after_one", "after", async () => {
        order.push("after_one");
        return 2;
      }),
      step("before_one", "before", async () => {
        order.push("before_one");
        return { enqueued: 1 };
      }),
      step(
        "prune",
        "after",
        async () => {
          order.push("prune");
          return 7;
        },
        true,
      ),
    ],
    drainProjectJobs: async () => {
      order.push("drain");
      return { done: 3, failed: 1 };
    },
    retentionEnabled: true,
    ...overrides,
  };
}

test("before steps run, then the drain, then after steps; results land in the summary", async () => {
  const order: string[] = [];
  const observed = observability();
  const summary = await runDrainTick(tick(order, { observability: observed.deps }));

  assert.deepEqual(order, ["before_one", "drain", "after_one", "prune"]);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.steps, { before_one: { enqueued: 1 }, after_one: 2, prune: 7 });
  assert.equal(summary.done, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.retention, true);
  assert.equal(summary.errors, undefined);
});

test("retention-only steps are skipped, and reported as skipped, when retention is off", async () => {
  const order: string[] = [];
  const summary = await runDrainTick(
    tick(order, { retentionEnabled: false, observability: observability().deps }),
  );
  assert.deepEqual(order, ["before_one", "drain", "after_one"]);
  assert.equal(summary.steps.prune, "skipped");
  assert.equal(summary.retention, false);
});

test("one failing step is recorded under its name and the tick stays ok", async () => {
  const order: string[] = [];
  const thrown = new Error("sweep exploded");
  const observed = observability();
  const deps = tick(order, { observability: observed.deps });
  deps.steps.unshift(
    step("broken", "before", async () => {
      throw thrown;
    }),
  );
  const summary = await runDrainTick(deps);

  assert.equal(summary.ok, true);
  assert.deepEqual(order, ["before_one", "drain", "after_one", "prune"]);
  assert.equal(summary.steps.broken, null);
  assert.deepEqual(summary.errors, { broken: "sweep exploded" });
  assert.deepEqual(observed.captures, [
    { error: thrown, distinctId: "system:cron", properties: { step: "broken" } },
  ]);
});

test("the heartbeat event always fires, flat numbers included, and a drain failure marks it not ok", async () => {
  const observed = observability();
  const ok = await runDrainTick(tick([], { observability: observed.deps }));
  assert.deepEqual(observed.events, [
    {
      event: "cron_drain_completed",
      context: { distinctId: "system:cron" },
      properties: {
        ok: true,
        done: 3,
        failed: 1,
        retention: true,
        duration_ms: ok.duration_ms,
        enqueued: 1,
        after_one: 2,
        prune: 7,
      },
    },
  ]);

  const second = observability();
  const failed = await runDrainTick(
    tick([], {
      observability: second.deps,
      drainProjectJobs: async () => {
        throw new Error("database gone");
      },
    }),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "database gone");
  assert.equal(second.events[0]?.properties.ok, false);
  assert.equal(second.events[0]?.properties.error, "database gone");
});

test("the heartbeat carries upstream's per-area error lists; a step upstream did not isolate is under otherErrors", async () => {
  const observed = observability();
  const failing = (name: string, message: string) =>
    step(name, "after", async () => {
      throw new Error(message);
    });
  const summary = await runDrainTick(
    tick([], {
      observability: observed.deps,
      steps: [
        failing("trace_summary_refresh", "refresh failed"),
        failing("trace_summary_prune", "prune failed"),
        failing("match_quality_sweep", "sweep failed"),
        failing("sealed_import_expiry", "expiry failed"),
        failing("otel_spans_prune", "spans failed"),
      ],
    }),
  );
  assert.equal(summary.ok, true);
  const heartbeat = observed.events[0]?.properties ?? {};
  assert.deepEqual(heartbeat.traceSummaryErrors, [
    "trace_summary_refresh: refresh failed",
    "trace_summary_prune: prune failed",
  ]);
  assert.deepEqual(heartbeat.matchQualityErrors, ["match_quality_sweep: sweep failed"]);
  assert.deepEqual(heartbeat.traceSignalErrors, ["sealed_import_expiry: expiry failed"]);
  assert.deepEqual(heartbeat.otherErrors, ["otel_spans_prune: spans failed"]);
  assert.equal("errors" in heartbeat, false, "no comma list: upstream's arrays only");
  assert.equal("qualityErrors" in heartbeat, false, "an area with no failure is left out");
});

test("data retention is opt-in", () => {
  assert.equal(dataRetentionEnabled(config({})), false);
  assert.equal(dataRetentionEnabled(config({ DATA_RETENTION_ENABLED: "0" })), false);
  assert.equal(dataRetentionEnabled(config({ DATA_RETENTION_ENABLED: "1" })), true);
  assert.equal(dataRetentionEnabled(config({ DATA_RETENTION_ENABLED: " 1 " })), true);
});
