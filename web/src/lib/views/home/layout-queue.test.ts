import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLayoutQueue,
  DROPPED,
  FAILED,
  type Saved,
} from "@/components/console/home/focused/layout-queue";
import type { LayoutSnapshot } from "@/lib/views/overview-layout/actions";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  type OverviewWidgetId,
} from "@/lib/views/overview-layout/domain/layout";

const snapshot = (
  revision: string,
  removed: readonly OverviewWidgetId[] = [],
  undo: string | null = null,
): LayoutSnapshot => ({
  revision,
  undo,
  layout: removed.reduce(
    (layout, widget) => changeLayout(layout, { kind: "remove", widget }),
    DEFAULT_LAYOUT,
  ),
});
const ok = (at: LayoutSnapshot): Saved => ({ ok: true, changed: "Changed", ...at });

/** A page that records what it is told, and writes that the test answers one by one. */
function page(initial = snapshot("1.a", ["topology"], "Removed Agents and MCP servers")) {
  const shown: LayoutSnapshot["layout"][] = [];
  const told: string[] = [];
  const calls: string[] = [];
  const queue = createLayoutQueue(initial, {
    show: (layout) => shown.push(layout),
    undoable: (undo) => told.push(`undo: ${undo}`),
    pending: (count) => told.push(`pending: ${count}`),
    refused: () => told.push("refused"),
    changedElsewhere: () => told.push("elsewhere"),
  });
  const write = (name: string) => {
    let answer: (result: Saved) => void = () => undefined;
    let fail: () => void = () => undefined;
    const result = new Promise<Saved>((resolve, reject) => {
      answer = resolve;
      fail = () => reject(new Error("offline"));
    });
    return {
      answer,
      fail,
      run: (base: string) => {
        calls.push(`${name} on ${base}`);
        return result;
      },
    };
  };
  return { queue, shown, told, calls, write };
}

test("writes run one after another, each on the revision of the one before it", async () => {
  const { queue, calls, shown, told, write } = page();
  const a = write("a");
  const b = write("b");
  const first = queue.enqueue(a.run);
  const second = queue.enqueue(b.run);
  a.answer(ok(snapshot("2.b", ["metrics"])));
  await first;
  assert.deepEqual(shown, [], "the one that waits is drawn on top of it");
  b.answer(ok(snapshot("3.c", ["health"])));
  await second;
  assert.deepEqual(calls, ["a on 1.a", "b on 2.b"]);
  assert.deepEqual(shown, [snapshot("", ["health"]).layout]);
  assert.equal(queue.current().revision, "3.c");
  assert.deepEqual(
    told.filter((text) => text.startsWith("pending")),
    ["pending: 1", "pending: 2", "pending: 1", "pending: 0"],
  );
});

test("a save that fails puts back the last saved layout, and the ones that wait still run", async () => {
  const { queue, calls, shown, told, write } = page();
  const a = write("a");
  const b = write("b");
  const first = queue.enqueue(a.run);
  const second = queue.enqueue(b.run);
  a.fail();
  assert.equal(await first, FAILED);
  assert.deepEqual(shown, [queue.current().layout]);
  assert.ok(told.includes("refused"));
  b.answer(ok(snapshot("2.b")));
  assert.ok((await second).ok);
  assert.deepEqual(calls, ["a on 1.a", "b on 1.a"]);
});

test("an undo that waits for a save that fails takes back nothing older", async () => {
  const { queue, calls, write } = page();
  const save = write("save");
  const undo = write("undo");
  const first = queue.enqueue(save.run);
  const second = queue.enqueueUndo(undo.run);
  const third = queue.enqueueUndo(undo.run);
  save.fail();
  assert.equal(await first, FAILED);
  assert.equal(await second, DROPPED);
  assert.equal(await third, DROPPED);
  assert.deepEqual(calls, ["save on 1.a"]);
  assert.equal(queue.current().revision, "1.a");
  const later = write("later");
  later.answer(ok(snapshot("2.b")));
  assert.ok((await queue.enqueueUndo(later.run)).ok, "a press after the failure is for what shows");
});

test("a dropped undo leaves what was saved before it on the page", async () => {
  const { queue, calls, shown, write } = page();
  const a = write("a");
  const b = write("b");
  const undo = write("undo");
  const first = queue.enqueue(a.run);
  const second = queue.enqueue(b.run);
  const third = queue.enqueueUndo(undo.run);
  a.fail();
  await first;
  b.answer(ok(snapshot("2.b", ["health"])));
  assert.ok((await second).ok);
  assert.equal(await third, DROPPED);
  assert.deepEqual(calls, ["a on 1.a", "b on 1.a"]);
  assert.deepEqual(shown.at(-1), snapshot("", ["health"]).layout);
});

test("a change in another place is shown, and what waits is dropped", async () => {
  const { queue, calls, shown, told, write } = page();
  const a = write("a");
  const b = write("b");
  const first = queue.enqueue(a.run);
  const second = queue.enqueue(b.run);
  const there = snapshot("5.z", ["attention"], "Removed Needs attention");
  a.answer({ ok: false, message: "stale", current: there });
  await first;
  assert.equal(await second, DROPPED);
  assert.deepEqual(calls, ["a on 1.a"]);
  assert.deepEqual(shown.at(-1), there.layout);
  assert.equal(queue.current().revision, "5.z");
  assert.ok(told.includes("elsewhere") && told.includes("undo: Removed Needs attention"));
});

test("a change is the latest until another one, a failure or a layout of another place", async () => {
  const { queue, write } = page();
  const save = async (answer: (w: ReturnType<typeof write>) => void) => {
    const a = write("a");
    const result = queue.enqueue(a.run);
    const named = queue.latest();
    answer(a);
    await result;
    return named;
  };
  const first = await save((a) => a.answer(ok(snapshot("2.b"))));
  assert.equal(queue.latest(), first);
  const second = await save((a) => a.answer(ok(snapshot("3.c"))));
  assert.notEqual(queue.latest(), first);
  assert.equal(queue.latest(), second);
  const failed = await save((a) => a.fail());
  assert.notEqual(queue.latest(), failed);

  const mine = await save((a) => a.answer(ok(snapshot("4.d", ["health"]))));
  queue.served(snapshot("4.d", ["health"]));
  queue.served(snapshot("3.c"));
  assert.equal(queue.latest(), mine, "the page's own save, and a late earlier one");
  assert.equal(queue.current().revision, "4.d");
  queue.served(snapshot("5.e", ["health", "metrics"]));
  assert.notEqual(queue.latest(), mine, "an agent's change");
  assert.equal(queue.current().revision, "5.e");
});

test("a render that comes while a save waits is not taken over", async () => {
  const { queue, shown, write } = page();
  const a = write("a");
  const result = queue.enqueue(a.run);
  queue.served(snapshot("9.z", ["health"]));
  assert.equal(queue.current().revision, "1.a");
  assert.deepEqual(shown, []);
  a.answer(ok(snapshot("2.b")));
  await result;
});

test("a history that was read is what the page shows, unless a save waits", async () => {
  const { queue, shown, told, write } = page();
  const named = queue.latest();
  queue.read(snapshot("1.a", ["topology"]));
  assert.equal(queue.latest(), named);
  queue.read(snapshot("6.f", ["metrics"]));
  assert.notEqual(queue.latest(), named);
  assert.deepEqual(shown, [snapshot("", ["metrics"]).layout]);
  assert.ok(told.includes("elsewhere"));
  const a = write("a");
  const result = queue.enqueue(a.run);
  queue.read(snapshot("7.g"));
  assert.equal(queue.current().revision, "6.f");
  a.answer(ok(snapshot("8.h")));
  await result;
});
