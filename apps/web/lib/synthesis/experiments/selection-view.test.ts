import assert from "node:assert/strict";
import { test } from "node:test";
import type { SelectionLogRecord } from "./calibration-types";
import { buildSelectionRankingView, selectionQuery } from "./selection-view";

const AT = new Date("2026-08-01T10:00:00.000Z");

function record(
  overrides: Partial<SelectionLogRecord> & { eventName: string },
): SelectionLogRecord {
  return {
    id: "log-1",
    occurredAt: AT,
    traceId: null,
    arm: null,
    role: null,
    experimentAttrs: {},
    ...overrides,
  };
}

test("buildSelectionRankingView reads arms, outcomes, durations, and agreement off the comparison record", () => {
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      arm: "ratel",
      role: "shadow",
      experimentAttrs: {
        "ratel.experiment.query": "mark task done",
        "ratel.experiment.served.arm": "legacy",
        "ratel.experiment.served.outcome": "ok",
        "ratel.experiment.served.duration_ms": 812,
        "ratel.experiment.served.hit_count": 3,
        "ratel.experiment.shadow.arm": "ratel",
        "ratel.experiment.shadow.outcome": "ok",
        "ratel.experiment.shadow.duration_ms": 36,
        "ratel.experiment.shadow.hit_count": 3,
        "ratel.experiment.agreement.top1": true,
        "ratel.experiment.agreement.exact_order": false,
        "ratel.experiment.agreement.overlap_count": 2,
        "ratel.experiment.agreement.jaccard_at_k": 0.5,
        "ratel.experiment.agreement.k": 3,
      },
    }),
  ]);

  assert.deepEqual(view, {
    occurredAt: AT,
    query: "mark task done",
    servedArm: "legacy",
    shadowArm: "ratel",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 812,
    shadowDurationMs: 36,
    servedHitCount: 3,
    shadowHitCount: 3,
    top1: true,
    exactOrder: false,
    overlapCount: 2,
    jaccardAtK: 0.5,
    agreementK: 3,
    servedResultIds: null,
    shadowResultIds: null,
    servedResultScores: null,
    shadowResultScores: null,
  });
});

test("buildSelectionRankingView nulls malformed comparison attributes instead of guessing", () => {
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      experimentAttrs: {
        "ratel.experiment.served.arm": 42,
        "ratel.experiment.served.duration_ms": "fast",
        "ratel.experiment.agreement.top1": "yes",
        "ratel.experiment.agreement.jaccard_at_k": Number.NaN,
      },
    }),
  ]);

  assert.ok(view);
  assert.equal(view.servedArm, null);
  assert.equal(view.servedDurationMs, null);
  assert.equal(view.top1, null);
  assert.equal(view.jaccardAtK, null);
});

test("buildSelectionRankingView stitches per-arm rankings from results records", () => {
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      arm: "ratel",
      role: "shadow",
      experimentAttrs: {
        "ratel.experiment.served.arm": "legacy",
        "ratel.experiment.shadow.arm": "ratel",
      },
    }),
    record({
      id: "log-2",
      eventName: "ratel.experiment.results",
      arm: "legacy",
      role: "serving",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["update_task", "complete_task"],
        "ratel.experiment.result_scores": [1, 0.62],
      },
    }),
    record({
      id: "log-3",
      eventName: "ratel.experiment.results",
      arm: "ratel",
      role: "shadow",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["complete_task", "update_task"],
        "ratel.experiment.result_scores": [1, 0.9],
      },
    }),
  ]);

  assert.ok(view);
  assert.deepEqual(view.servedResultIds, ["update_task", "complete_task"]);
  assert.deepEqual(view.shadowResultIds, ["complete_task", "update_task"]);
  assert.deepEqual(view.servedResultScores, [1, 0.62]);
  assert.deepEqual(view.shadowResultScores, [1, 0.9]);
});

test("buildSelectionRankingView normalizes arms and filters malformed ranking elements like the list", () => {
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      experimentAttrs: {
        "ratel.experiment.served.arm": "  legacy  ",
        "ratel.experiment.shadow.arm": " ratel ",
      },
    }),
    record({
      id: "log-2",
      eventName: "ratel.experiment.results",
      arm: "legacy",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["a", 7, "b", null],
        "ratel.experiment.result_scores": [1, "high", 0.5, Number.NaN],
      },
    }),
    record({
      id: "log-3",
      eventName: "ratel.experiment.results",
      arm: "ratel",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["b", "a"],
      },
    }),
  ]);

  assert.ok(view);
  assert.equal(view.servedArm, "legacy");
  assert.equal(view.shadowArm, "ratel");
  assert.deepEqual(view.servedResultIds, ["a", "b"]);
  assert.deepEqual(view.servedResultScores, [1, 0.5]);
  assert.deepEqual(view.shadowResultIds, ["b", "a"]);
});

test("buildSelectionRankingView filters malformed ids and rejects non-array scores", () => {
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      experimentAttrs: {
        "ratel.experiment.served.arm": "legacy",
        "ratel.experiment.shadow.arm": "ratel",
      },
    }),
    record({
      id: "log-2",
      eventName: "ratel.experiment.results",
      arm: "legacy",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["update_task", 7],
        "ratel.experiment.result_scores": "high",
      },
    }),
  ]);

  assert.ok(view);
  assert.deepEqual(view.servedResultIds, ["update_task"]);
  assert.equal(view.servedResultScores, null);
  assert.equal(view.shadowResultIds, null);
});

test("buildSelectionRankingView falls back to the comparison record's own arm for the shadow arm", () => {
  // The SDK attributes comparison records to the shadow arm, so the promoted
  // arm column stands in when the shadow.arm attr is absent — mirroring
  // shadowArmColumn() in the SQL layer.
  const view = buildSelectionRankingView([
    record({
      eventName: "ratel.experiment.comparison",
      arm: "ratel",
      role: "shadow",
      experimentAttrs: {
        "ratel.experiment.served.arm": "legacy",
      },
    }),
    record({
      id: "log-2",
      eventName: "ratel.experiment.results",
      arm: "ratel",
      role: "shadow",
      experimentAttrs: {
        "ratel.experiment.result_ids": ["update_task"],
      },
    }),
  ]);

  assert.ok(view);
  assert.equal(view.shadowArm, "ratel");
  assert.deepEqual(view.shadowResultIds, ["update_task"]);
});

test("buildSelectionRankingView returns null without a comparison record", () => {
  assert.equal(buildSelectionRankingView([record({ eventName: "ratel.experiment.drop" })]), null);
  assert.equal(buildSelectionRankingView([]), null);
});

test("selectionQuery reads the query off a lifecycle record when no comparison ran", () => {
  // A skipped or dropped shadow never emits a comparison, so the inspector's
  // query has to come from whichever record carried it, because otherwise the one
  // selection most worth reproducing by hand reads as "query unavailable".
  assert.equal(
    selectionQuery([
      record({
        eventName: "ratel.experiment.skip",
        arm: "ratel",
        role: "shadow",
        experimentAttrs: {
          "ratel.experiment.query": "deploy the service to production",
          "ratel.experiment.skip.reason": "capacity",
        },
      }),
    ]),
    "deploy the service to production",
  );
});

test("selectionQuery prefers the first record carrying a query and ignores blanks", () => {
  assert.equal(
    selectionQuery([
      record({ eventName: "ratel.experiment.results" }),
      record({
        eventName: "ratel.experiment.drop",
        experimentAttrs: { "ratel.experiment.query": "   " },
      }),
      record({
        eventName: "ratel.experiment.comparison",
        experimentAttrs: { "ratel.experiment.query": "explain this stack trace" },
      }),
    ]),
    "explain this stack trace",
  );
});

test("selectionQuery returns null when nothing carried a query", () => {
  assert.equal(selectionQuery([record({ eventName: "ratel.experiment.drop" })]), null);
  assert.equal(selectionQuery([]), null);
});
