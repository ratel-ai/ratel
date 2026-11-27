import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resolveConfig } from "@/config";
import { LONG_JOB_KINDS, RUN_IMPORT_JOB, SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { DEFAULT_DRAIN_TIMEOUT_MS, drainTimeoutMs } from "./drain-observer";
import type { WorkerDeps } from "./worker";
import {
  type BackgroundWorkerDeps,
  LANE_KINDS,
  reportTopQueries,
  startBackgroundWorker,
  stopBackgroundWorker,
  workerTick,
} from "./worker-start";

/** The settings `env` resolves to (`web/src/config.ts`). */
const config = (env: Record<string, string> = {}) => resolveConfig({ env });

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
  assert.equal(loop.drainImports, undefined, "no import lane unless one is given");
  assert.equal(h.warnings.length, 0);
  h.finishStep();
});

test("imports drain in a lane of their own, so a long import never holds analysis back", async () => {
  const h = harness({
    drainImports: async () => {
      h.calls.push("imports");
      return { done: 1, failed: 0 };
    },
  });
  startBackgroundWorker(h.deps);
  const loop = h.wired.loop;
  assert.ok(loop?.drainImports);
  assert.deepEqual(await loop.drainImports(), { done: 1, failed: 0 });
  assert.deepEqual(await loop.drain(), { done: 2, failed: 1 });
  assert.deepEqual(h.calls, ["imports", "drain"]);
  h.finishStep();
});

test("the daily report logs the most expensive statements by rank, then resets the counts", async () => {
  const logged: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  const log = {
    info: (fields: Record<string, unknown>, message: string) =>
      logged.push({ level: "info", message, fields }),
    warn: (fields: Record<string, unknown>, message: string) =>
      logged.push({ level: "warn", message, fields }),
    error: (fields: Record<string, unknown>, message: string) =>
      logged.push({ level: "error", message, fields }),
  } as unknown as Parameters<typeof reportTopQueries>[1];
  const executed: string[] = [];
  const db = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query.queryChunks ?? query);
      executed.push(text.includes("pg_stat_statements_reset") ? "reset" : "read");
      if (text.includes("pg_stat_statements_reset")) return { rows: [] };
      if (text.includes("pg_extension")) return { rows: [{ installed: true }] };
      return {
        rows: [
          { calls: 10, total_ms: 900, mean_ms: 90, rows: 10, disk_reads: 3, query: "select $1" },
          { calls: 2, total_ms: 400, mean_ms: 200, rows: 1, disk_reads: 0, query: "update $1" },
        ],
      };
    },
  } as unknown as Parameters<typeof reportTopQueries>[0];
  await reportTopQueries(db, log);
  const lines = logged.filter((line) => line.message === "db_top_query");
  assert.deepEqual(
    lines.map((line) => line.fields.rank),
    [1, 2],
  );
  assert.equal(executed.at(-1), "reset", "the counts reset after the report");

  logged.length = 0;
  const failing = {
    execute: async () => {
      throw new Error("database gone");
    },
  } as unknown as Parameters<typeof reportTopQueries>[0];
  await reportTopQueries(failing, log);
  assert.deepEqual(
    logged.map((line) => [line.level, line.message]),
    [["error", "top queries report failed"]],
  );
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
  assert.equal(drainTimeoutMs(config({})), DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(DEFAULT_DRAIN_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(drainTimeoutMs(config({ CRON_DRAIN_TIMEOUT_MS: "120000" })), 120_000);
  assert.equal(drainTimeoutMs(config({ CRON_DRAIN_TIMEOUT_MS: "0" })), 0);
  assert.throws(() => config({ CRON_DRAIN_TIMEOUT_MS: "ten minutes" }), /CRON_DRAIN_TIMEOUT_MS/);
  assert.throws(() => config({ CRON_DRAIN_TIMEOUT_MS: "-1" }), /CRON_DRAIN_TIMEOUT_MS/);
});

test("builds drain in a lane of their own, so a long build never holds an import back", async () => {
  const h = harness({
    drainBuilds: async () => {
      h.calls.push("builds");
      return { done: 1, failed: 0 };
    },
  });
  startBackgroundWorker(h.deps);
  const loop = h.wired.loop;
  const drained = await loop?.drainBuilds?.();
  h.finishStep();
  assert.deepEqual(drained, { done: 1, failed: 0 });
  assert.deepEqual(h.calls, ["builds"]);
});

test("the lanes of the worker share no job kind", () => {
  assert.deepEqual(LANE_KINDS.imports, { only: [RUN_IMPORT_JOB] });
  assert.deepEqual(LANE_KINDS.builds, { only: [SANDBOX_IMAGE_BUILD_JOB] });
  assert.deepEqual(LANE_KINDS.analysis, { except: LONG_JOB_KINDS });
});

test("what runs beside the loop is stopped with it, before the flush and the exit", async () => {
  const h = harness();
  const order: string[] = [];
  let finishMessage: () => void = () => {};
  const message = new Promise<void>((resolve) => {
    finishMessage = resolve;
  });
  startBackgroundWorker(h.deps, {
    beforeExit: async () => {
      order.push("flush");
    },
    beside: {
      stop: async () => {
        order.push("stop");
        await message;
        order.push("stopped");
      },
    },
  });
  h.listeners.SIGTERM?.();
  h.finishStep();
  await settle();
  assert.deepEqual(order, ["stop"]);
  assert.deepEqual(h.exits, []);
  finishMessage();
  await settle();
  await settle();
  assert.deepEqual(order, ["stop", "stopped", "flush"]);
  assert.deepEqual(h.exits, [0]);
});

test("a failed stop beside the loop does not keep the process alive", async () => {
  const h = harness();
  startBackgroundWorker(h.deps, { beside: { stop: () => Promise.reject(new Error("gone")) } });
  h.listeners.SIGTERM?.();
  h.finishStep();
  await settle();
  await settle();
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.warnings.length, 1);
});

test("the worker runs the registered lanes; a persist-only process runs only them", async () => {
  const lane = { name: "ingest", concurrency: 2, step: async () => ({ done: 0, failed: 0 }) };
  const worker = harness({ lanes: () => [lane] });
  startBackgroundWorker(worker.deps);
  assert.deepEqual(worker.wired.loop?.extraLanes, [lane]);
  assert.notEqual(worker.wired.loop?.analysis, false);
  worker.finishStep();
  await stopBackgroundWorker();

  const persist = harness({ lanes: () => [lane] });
  startBackgroundWorker(persist.deps, { lanesOnly: true });
  assert.deepEqual(persist.wired.loop?.extraLanes, [lane]);
  assert.equal(persist.wired.loop?.analysis, false);
  persist.finishStep();
});
