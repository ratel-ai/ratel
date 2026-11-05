import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { WorkerDeps } from "./worker";
import {
  type BackgroundWorkerDeps,
  startBackgroundWorker,
  stopBackgroundWorker,
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
