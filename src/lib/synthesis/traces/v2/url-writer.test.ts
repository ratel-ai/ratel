import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUrlWriter,
  type QueryUpdates,
  type WriterTimers,
  withQueryUpdates,
} from "./url-writer";

/** Timers you advance by hand. */
function manualTimers(): WriterTimers & { advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) {
      const handle = next++;
      queue.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...queue]) {
        if (timer.at <= now) {
          queue.delete(handle);
          timer.callback();
        }
      }
    },
    pending: () => queue.size,
  };
}

test("holding j writes the URL once, when the selection rests, with every change merged", () => {
  const timers = manualTimers();
  const writes: QueryUpdates[] = [];
  const writer = createUrlWriter((updates) => writes.push(updates), 400, timers);
  for (let step = 0; step < 300; step += 1) {
    writer.set({ span: `span-${step}` });
    timers.advance(33);
  }
  writer.set({ tab: "details" });
  assert.equal(writes.length, 0, "300 steps in 10 seconds: no write while moving");
  timers.advance(400);
  assert.deepEqual(writes, [{ span: "span-299", tab: "details" }]);
  assert.equal(timers.pending(), 0);
});

test("leaving the page drops what was queued", () => {
  const timers = manualTimers();
  const writes: QueryUpdates[] = [];
  const writer = createUrlWriter((updates) => writes.push(updates), 400, timers);
  writer.set({ span: "a" });
  writer.cancel();
  timers.advance(1_000);
  assert.deepEqual(writes, []);
  writer.set({ span: "b" });
  timers.advance(400);
  assert.deepEqual(writes, [{ span: "b" }], "and it keeps working after");
});

test("updates set and remove parameters and leave the rest alone", () => {
  assert.equal(
    withQueryUpdates("?range=3m&tab=details", { tab: null, span: "f7a1" }),
    "?range=3m&span=f7a1",
  );
  assert.equal(withQueryUpdates("", { tab: null }), "");
});
