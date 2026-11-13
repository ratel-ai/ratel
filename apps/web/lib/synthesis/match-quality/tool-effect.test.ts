import assert from "node:assert/strict";
import { test } from "node:test";
import { servedInList, toolEffectView } from "./tool-effect";

const effect = (entryId: string, overrides: Record<string, unknown> = {}) => ({
  entryId,
  n: 10,
  delta: 0,
  found: 0,
  lost: 0,
  promoted: 0,
  demoted: 0,
  patched: false,
  ...overrides,
});

test("the card reads the tool's own searches, not the whole catalog", () => {
  const view = toolEffectView(
    {
      byEntry: [
        effect("create_task", { n: 28, containedBefore: 19, containedAfter: 28, patched: true }),
        effect("update_task", { n: 29, containedBefore: 29, containedAfter: 29 }),
      ],
    },
    "create_task",
  )!;
  assert.equal(view.containedBefore, 19);
  assert.equal(view.containedAfter, 28);
  assert.equal(view.beforePercent, "68%");
  assert.equal(view.afterPercent, "100%");
  assert.equal(view.delta, "+32%");
  assert.equal(view.direction, "up");
});

test("a rewrite that makes its own tool worse reads as down", () => {
  const view = toolEffectView(
    { byEntry: [effect("t", { containedBefore: 8, containedAfter: 6, patched: true })] },
    "t",
  )!;
  assert.equal(view.direction, "down");
  assert.equal(view.delta, "−20%");
});

test("an unmoved tool reads as no change", () => {
  const view = toolEffectView(
    { byEntry: [effect("t", { containedBefore: 6, containedAfter: 6, patched: true })] },
    "t",
  )!;
  assert.equal(view.direction, "flat");
  assert.equal(view.delta, "No change");
});

test("results without per-tool counts fall back to the old card", () => {
  assert.equal(toolEffectView({ byEntry: [effect("t", { patched: true })] }, "t"), null);
  assert.equal(toolEffectView({ byEntry: [] }, "t"), null);
  assert.equal(toolEffectView(null, "t"), null);
});

test("servedInList is production's own count from the evidence", () => {
  assert.deepEqual(servedInList({ targeted: 30, misses: 1 }), { contained: 29, n: 30 });
  assert.equal(servedInList({}), null);
  assert.equal(servedInList({ targeted: 0, misses: 0 }), null);
});
