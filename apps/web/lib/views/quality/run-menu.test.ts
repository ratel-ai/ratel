import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchQualityRunRow } from "@/lib/synthesis/match-quality/schema";
import { budgetLine, runMenuModel, runStatusLine } from "./run-menu";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function run(overrides: Partial<MatchQualityRunRow> = {}): MatchQualityRunRow {
  return {
    status: "analyzed",
    createdAt: new Date("2026-10-12T12:00:00.000Z"),
    finishedAt: new Date("2026-10-12T12:05:00.000Z"),
    ...overrides,
  } as MatchQualityRunRow;
}

const COUNTS = new Map([
  [7, 312],
  [14, 0],
  [30, 598],
]);

test("each window says how much it would read, and an empty one cannot be run", () => {
  const model = runMenuModel({
    run: run(),
    windows: [7, 14, 30],
    counts: COUNTS,
    budget: { spent: false, remaining: 3 },
    now: NOW,
  });
  assert.equal(model.live, false);
  assert.equal(model.label, "Analyse searches");
  assert.deepEqual(
    model.windows.map((window) => [window.label, window.detail, window.disabled]),
    [
      ["Last 7 days", "312 searches", false],
      ["Last 14 days", "No searches", true],
      ["Last 30 days", "598 searches", false],
    ],
  );
  assert.equal(model.status, "Analysed 3 days ago");
  assert.equal(model.budget, "3 runs left this month");
  assert.equal(model.nextRun, "Next automatic run in 4 days");
});

test("a live run locks the menu and keeps its label with the pending ellipsis", () => {
  const model = runMenuModel({
    run: run({ status: "running", createdAt: new Date("2026-10-15T11:59:00Z") }),
    windows: [7],
    counts: COUNTS,
    budget: { spent: false, remaining: 3 },
    now: NOW,
  });
  assert.equal(model.live, true);
  assert.equal(model.label, "Analysing…");
  assert.equal(model.windows[0]!.disabled, true);
  assert.equal(model.nextRun, null);
});

test("a spent allowance says when it comes back and disables every window", () => {
  const model = runMenuModel({
    run: null,
    windows: [7, 30],
    counts: new Map(),
    budget: { spent: true, limit: 5, resetsAt: new Date("2026-11-01T00:00:00Z") },
    now: NOW,
  });
  assert.equal(model.budget, "All 5 runs used this month. More on 1 November.");
  assert.ok(model.windows.every((window) => window.disabled));
  assert.equal(model.windows[0]!.detail, "", "counts not read yet: no claim");
  assert.equal(model.status, "Not analysed yet");
});

test("run status and allowance in words", () => {
  assert.equal(runStatusLine(run({ status: "queued" }), NOW), "Queued");
  assert.equal(runStatusLine(run({ status: "running" }), NOW), "Reading your searches");
  assert.equal(runStatusLine(run({ status: "failed" }), NOW), "The last analysis didn't finish");
  assert.equal(
    runStatusLine(run({ finishedAt: new Date(NOW.getTime() - 20_000) }), NOW),
    "Analysed just now",
  );
  assert.equal(budgetLine({ spent: false, remaining: 1 }), "1 run left this month");
  assert.equal(budgetLine({ spent: false, remaining: Number.POSITIVE_INFINITY }), "Unlimited runs");
});
