import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_DRAIN_TIMEOUT_MS, drainTimeoutMs } from "./drain-observer";
import type { WorkerDeps } from "./worker";
import {
  type BackgroundWorkerDeps,
  startBackgroundWorker,
  stopBackgroundWorker,
  workerTick,
} from "./worker-start";

/** A worker whose loop is a recording: what it was wired to, its signals, its exits. */
function harness(overrides: Partial<BackgroundWorkerDeps> = {}) {
  const calls: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const listeners: Partial<Record<"SIGTERM" | "SIGINT", () => void>> = {};
  const exits: number[] = [];
  const wired: { loop?: WorkerDeps } = {};
  let started = 0;
  let finishStep: () => void = () => {};
  const stepInFlight = new Promise<void>((resolve) => {
    finishStep = resolve;
  });
  const deps: BackgroundWorkerDeps = {
    drain: async () => {
      calls.push("drain");
      return { done: 2, failed: 1 };
    },
    tick: async () => {
      calls.push("tick");
      return { ok: true };
    },
    startWorker: (loop) => {
      started += 1;
      wired.loop = loop;
      return {
        stop: async () => {
          calls.push("stop");
          await stepInFlight;
        },
      };
    },
    on: (signal, listener) => {
      listeners[signal] = listener;
    },
    exit: (code) => {
      exits.push(code);
    },
    warn: (fields) => {
      warnings.push(fields);
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    warnings,
    listeners,
    exits,
    wired,
    started: () => started,
    finishStep: () => finishStep(),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await stopBackgroundWorker();
});

test("the loop drains every project's jobs and sweeps with the cron tick, in this process", async () => {
  const h = harness();
  startBackgroundWorker(h.deps);
  const loop = h.wired.loop;
  assert.ok(loop);
  assert.deepEqual(await loop.drain(), { done: 2, failed: 1 });
  await loop.sweep();
  assert.deepEqual(h.calls, ["drain", "tick"]);
  assert.equal(loop.drainImports, undefined, "no import lane in this edition");
  assert.equal(h.warnings.length, 0);
  h.finishStep();
});

test("a tick that finished with an error is a warning, never a failed step", async () => {
  const h = harness({ tick: async () => ({ ok: false, error: "database gone" }) });
  startBackgroundWorker(h.deps);
  await h.wired.loop?.sweep();
  assert.deepEqual(h.warnings, [{ error: "database gone" }]);
  h.finishStep();
});

test("a stop signal waits for the step in flight, then exits 0", async () => {
  const h = harness();
  startBackgroundWorker(h.deps);
  assert.ok(h.listeners.SIGTERM && h.listeners.SIGINT);

  h.listeners.SIGTERM();
  await settle();
  assert.deepEqual(h.calls, ["stop"]);
  assert.deepEqual(h.exits, [], "still running its step");

  h.finishStep();
  await settle();
  assert.deepEqual(h.exits, [0]);
});

test("a stop runs the flush after the step in flight and before the exit", async () => {
  const h = harness();
  startBackgroundWorker(h.deps, {
    beforeExit: async () => {
      h.calls.push("flush");
    },
  });
  h.listeners.SIGTERM?.();
  await settle();
  assert.deepEqual(h.calls, ["stop"], "nothing is flushed while the step runs");

  h.finishStep();
  await settle();
  assert.deepEqual(h.calls, ["stop", "flush"]);
  assert.deepEqual(h.exits, [0]);
});

test("a flush that fails is a warning and the worker still exits 0", async () => {
  const h = harness();
  startBackgroundWorker(h.deps, {
    beforeExit: async () => {
      throw new Error("collector gone");
    },
  });
  h.listeners.SIGTERM?.();
  h.finishStep();
  await settle();
  assert.deepEqual(h.warnings, [{ error: "Error: collector gone" }]);
  assert.deepEqual(h.exits, [0]);
});

test("a second signal does not wait", async () => {
  const h = harness();
  startBackgroundWorker(h.deps);
  h.listeners.SIGINT?.();
  await settle();
  h.listeners.SIGINT?.();
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.calls, ["stop"], "the loop was told to stop once");
  h.finishStep();
});

test("starting twice in one process keeps the first worker", () => {
  const first = harness();
  const second = harness();
  const handle = startBackgroundWorker(first.deps);
  assert.equal(startBackgroundWorker(second.deps), handle);
  assert.equal(first.started(), 1);
  assert.equal(second.started(), 0);
  assert.equal(second.listeners.SIGTERM, undefined);
  first.finishStep();
});

test("the worker's tick logs the drain heartbeat the monitors read, and a throw is a failed tick", async () => {
  const codes: string[] = [];
  const observer = {
    oldestQueuedJobAgeMs: async () => 0,
    log: (_level: string, _fields: unknown, code: string) => codes.push(code),
    reportException: () => {},
  };
  assert.deepEqual(await workerTick(async () => ({ ok: true }), observer)(), { ok: true });
  assert.deepEqual(codes, ["drain_started", "drain_completed"]);

  codes.length = 0;
  const failed = await workerTick(async () => {
    throw new Error("gone");
  }, observer)();
  assert.deepEqual(failed, { ok: false, error: "drain did not finish" });
  assert.deepEqual(codes, ["drain_started", "drain_failed"]);
});

/** A tick the test settles by hand; each call is one entry. */
function hangingTick() {
  const calls: Array<() => void> = [];
  const progress: Array<() => void> = [];
  const run = (onProgress: () => void) =>
    new Promise<{ ok: boolean }>((resolve) => {
      progress.push(onProgress);
      calls.push(() => resolve({ ok: true }));
    });
  return { calls, progress, run };
}

function recorder() {
  const logged: Array<{ level: string; code: string; fields: Record<string, unknown> }> = [];
  const reported: unknown[] = [];
  return {
    logged,
    reported,
    codes: () => logged.map((entry) => entry.code),
    deps: {
      oldestQueuedJobAgeMs: async () => 0,
      log: (level: "info" | "warn" | "error", fields: Record<string, unknown>, code: string) =>
        logged.push({ level, code, fields: { ...fields } }),
      reportException: (error: unknown) => reported.push(error),
    } as Parameters<typeof workerTick>[1],
  };
}

test("a hung worker tick times out, is logged and reported, and the tick returns a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const o = recorder();
  const { calls, run } = hangingTick();
  const tick = workerTick(run, o.deps, 60_000)();
  t.mock.timers.tick(60_000);
  assert.deepEqual(await tick, { ok: false, error: "drain did not finish" });

  assert.deepEqual(o.codes(), ["drain_started", "drain_timed_out"]);
  assert.equal(o.logged[1]?.level, "error");
  assert.deepEqual(o.logged[1]?.fields, { duration_ms: 60_000, timeout_ms: 60_000 });
  assert.equal(o.reported.length, 1);
  calls[0]?.();
});

test("each finished job restarts the limit, so a long healthy tick never times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const o = recorder();
  const { calls, progress, run } = hangingTick();
  const tick = workerTick(run, o.deps, 60_000)();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(50_000);
    progress[0]?.();
  }
  calls[0]?.();
  assert.deepEqual(await tick, { ok: true });
  assert.ok(!o.codes().includes("drain_timed_out"));
  assert.equal(o.codes().filter((code) => code === "drain_progress").length, 3);
});

test("a timed-out tick that settles late logs its completion, marked timed_out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const o = recorder();
  const { calls, run } = hangingTick();
  const first = workerTick(run, o.deps, 60_000)();
  t.mock.timers.tick(60_000);
  await first;

  calls[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await Promise.resolve();

  assert.deepEqual(o.codes(), ["drain_started", "drain_timed_out", "drain_completed"]);
  assert.equal(o.logged[2]?.fields.timed_out, true);
  assert.equal(o.reported.length, 1);
});

test("ticks cannot pile up: with two unsettled, the next is skipped until one settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const o = recorder();
  const { calls, run } = hangingTick();
  const tick = workerTick(run, o.deps, 60_000);
  for (let i = 0; i < 2; i++) {
    const pending = tick();
    t.mock.timers.tick(60_000);
    await pending;
  }
  assert.equal(calls.length, 2);

  assert.deepEqual(await tick(), { ok: false, error: "drain did not finish" });
  assert.equal(calls.length, 2, "no third tick runs");
  assert.equal(o.logged.at(-1)?.code, "drain_skipped_hung");

  calls[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const next = tick();
  assert.equal(calls.length, 3, "a settled tick frees its place");
  calls[1]?.();
  calls[2]?.();
  await next;
});

test("the watchdog limit reads CRON_DRAIN_TIMEOUT_MS: ten minutes by default, 0 turns it off", () => {
  assert.equal(drainTimeoutMs({}), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(DEFAULT_DRAIN_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(drainTimeoutMs({ CRON_DRAIN_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(drainTimeoutMs({ CRON_DRAIN_TIMEOUT_MS: "0" }), 0);
  assert.equal(drainTimeoutMs({ CRON_DRAIN_TIMEOUT_MS: "ten minutes" }), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(drainTimeoutMs({ CRON_DRAIN_TIMEOUT_MS: "-1" }), DEFAULT_DRAIN_TIMEOUT_MS);
});
