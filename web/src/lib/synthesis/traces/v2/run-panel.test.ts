import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreshSummary, SUMMARY_FRESH_MS, summaryKey } from "./run-panel";
import { buildRunSummary, type RunSpan } from "./run-summary";

function runSpan(overrides: Partial<RunSpan> & { spanId: string }): RunSpan {
  const startedAt = new Date("2026-10-15T12:00:00.000Z");
  return {
    parentSpanId: null,
    name: "agent.run",
    spanClass: "other",
    operationName: null,
    model: null,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 10),
    durationMs: 10,
    statusCode: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    searchQuery: null,
    searchTarget: null,
    searchHitCount: null,
    attributes: {},
    ...overrides,
  };
}

test("the Panel keeps a run per span count, so a list with more spans reads it again", () => {
  assert.equal(summaryKey("abc", 3), "abc:3");
  assert.notEqual(summaryKey("abc", 3), summaryKey("abc", 4));
  assert.equal(summaryKey("abc", undefined), "abc", "a run opened from a link, not in the list");
});

test("a finished run stays read; an unfinished run and a failed read go stale after a few seconds", () => {
  const at = 1_000_000;
  const finished = {
    result: {
      ok: true as const,
      summary: buildRunSummary([runSpan({ spanId: "root" })]),
      truncated: false,
    },
    at,
  };
  assert.equal(isFreshSummary(finished, at + 10 * SUMMARY_FRESH_MS), true);
  const unfinished = {
    result: {
      ok: true as const,
      summary: buildRunSummary([runSpan({ spanId: "child", parentSpanId: "root" })]),
      truncated: false,
    },
    at,
  };
  assert.equal(unfinished.result.summary.status, "incomplete");
  assert.equal(isFreshSummary(unfinished, at + 1_000), true, "j and k back and forth reuse it");
  assert.equal(isFreshSummary(unfinished, at + SUMMARY_FRESH_MS), false);
  const failed = {
    result: { ok: false as const, message: "Couldn't load this run. Try again in a moment." },
    at,
  };
  assert.equal(isFreshSummary(failed, at + SUMMARY_FRESH_MS + 1), false);
});
