import assert from "node:assert/strict";
import { test } from "node:test";
import { withActed } from "@/lib/views/fixes/acted";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";

const model = buildFixes(fixesInput());
const NOW = "2026-10-20T12:30:00.000Z";

test("an applied rewrite leaves the open list at once and waits under Applied, ready to revert", () => {
  const { open, applied } = withActed(model, new Map([["rewrite:mq-lookup", "applied"]]), NOW);
  assert.equal(
    open.some((fix) => fix.id === "rewrite:mq-lookup"),
    false,
  );
  const moved = applied.find((fix) => fix.id === "rewrite:mq-lookup");
  assert.equal(moved?.status, "applied");
  assert.equal(moved?.appliedAt, NOW);
  assert.deepEqual(
    [moved?.actions.apply, moved?.actions.dismiss, moved?.actions.revert],
    [false, false, true],
  );
  assert.equal(applied[0]?.id, "rewrite:mq-lookup");
});

test("a dismissed fix is gone, and a reverted one leaves Applied", () => {
  const { open, applied } = withActed(
    model,
    new Map([
      ["rewrite:mq-lookup", "dismissed"],
      ["rewrite:mq-notify", "reverted"],
    ]),
    NOW,
  );
  assert.equal(
    open.some((fix) => fix.id === "rewrite:mq-lookup"),
    false,
  );
  assert.equal(applied.length, 0);
});

test("Undo right after Apply closes the fix, as Revert does", () => {
  const { open, applied } = withActed(model, new Map([["rewrite:mq-lookup", "reverted"]]), NOW);
  assert.equal(
    open.some((fix) => fix.id === "rewrite:mq-lookup"),
    false,
  );
  assert.equal(
    applied.some((fix) => fix.id === "rewrite:mq-lookup"),
    false,
  );
});

test("once the server agrees, nothing is listed twice", () => {
  const refreshed = {
    open: model.open.filter((fix) => fix.id !== "rewrite:mq-lookup"),
    applied: [{ ...model.open[1]!, status: "applied" as const }, ...model.applied],
  };
  const { open, applied } = withActed(refreshed, new Map([["rewrite:mq-lookup", "applied"]]), NOW);
  assert.equal(open.length, model.open.length - 1);
  assert.equal(applied.filter((fix) => fix.id === "rewrite:mq-lookup").length, 1);
});
