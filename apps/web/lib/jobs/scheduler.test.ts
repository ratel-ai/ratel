import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createScheduler,
  DEFAULT_INTERVAL_MS,
  inProcessCronEnabled,
  startInProcessScheduler,
  stopInProcessScheduler,
} from "./scheduler";

/** A fake interval: the test fires the callback by hand. */
function fakeTimers() {
  let callback: (() => void) | undefined;
  let interval: number | undefined;
  let cleared = 0;
  const unref = { calls: 0 };
  const handle = {
    unref() {
      unref.calls++;
      return handle;
    },
  };
  return {
    setInterval: ((cb: () => void, ms: number) => {
      callback = cb;
      interval = ms;
      return handle;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      cleared++;
    }) as unknown as typeof clearInterval,
    fire: () => callback?.(),
    get interval() {
      return interval;
    },
    get cleared() {
      return cleared;
    },
    unref,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("ticks every interval, never keeps the process alive, and runs one tick at boot", async () => {
  const timers = fakeTimers();
  let ticks = 0;
  const handle = createScheduler({
    tick: async () => {
      ticks++;
    },
    intervalMs: 5_000,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await handle.tickNow();
  assert.equal(ticks, 1, "the boot tick");
  assert.equal(timers.interval, 5_000);
  assert.equal(timers.unref.calls, 1);

  timers.fire();
  await handle.tickNow();
  assert.equal(ticks, 2);
  assert.equal(DEFAULT_INTERVAL_MS, 60_000);
  handle.stop();
});

test("a slow tick is never overlapped: later firings coalesce into the one in flight", async () => {
  const timers = fakeTimers();
  const gate = deferred();
  let ticks = 0;
  const handle = createScheduler({
    tick: async () => {
      ticks++;
      await gate.promise;
    },
    immediate: false,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.equal(handle.running, false);
  timers.fire();
  timers.fire();
  timers.fire();
  assert.equal(handle.running, true);
  assert.equal(ticks, 1);
  gate.resolve();
  await handle.tickNow();
  assert.equal(handle.running, false);
  timers.fire();
  await handle.tickNow();
  assert.equal(ticks, 2, "the next firing after the tick finished runs again");
  handle.stop();
});

test("stop clears the interval and later firings do nothing", async () => {
  const timers = fakeTimers();
  let ticks = 0;
  const handle = createScheduler({
    tick: async () => {
      ticks++;
    },
    immediate: false,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  handle.stop();
  assert.equal(timers.cleared, 1);
  timers.fire();
  await Promise.resolve();
  assert.equal(ticks, 0);
});

test("a throwing tick reports the error and the scheduler keeps going", async () => {
  const timers = fakeTimers();
  const errors: unknown[] = [];
  let calls = 0;
  const handle = createScheduler({
    tick: async () => {
      calls++;
      if (calls === 1) throw new Error("tick failed");
    },
    immediate: false,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    onError: (error) => errors.push(error),
  });
  timers.fire();
  await handle.tickNow();
  assert.equal((errors[0] as Error).message, "tick failed");
  timers.fire();
  await handle.tickNow();
  assert.equal(calls, 2);
  handle.stop();
});

test("the process-global start is idempotent across module reloads", async () => {
  const timers = fakeTimers();
  let ticks = 0;
  const deps = {
    tick: async () => {
      ticks++;
    },
    immediate: false,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
  try {
    const first = startInProcessScheduler(deps);
    const second = startInProcessScheduler(deps);
    assert.equal(first, second);
    timers.fire();
    await first.tickNow();
    assert.equal(ticks, 1);
  } finally {
    stopInProcessScheduler();
  }
  assert.equal(timers.cleared, 1);
});

test("RATEL_CRON decides where the tick runs; unset means in process for the open-source edition", () => {
  assert.equal(inProcessCronEnabled({ RATEL_CRON: "inprocess" }), true);
  assert.equal(inProcessCronEnabled({ RATEL_CRON: "external", RATEL_COMPOSITION: "oss" }), false);
  assert.equal(inProcessCronEnabled({}), true);
  assert.equal(inProcessCronEnabled({ RATEL_COMPOSITION: "oss" }), true);
  assert.equal(inProcessCronEnabled({ RATEL_COMPOSITION: "cloud" }), false);
});
