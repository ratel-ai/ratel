import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_ROWS, previewDataset } from "../datasets";
import type { TurnContent } from "../domain/from-turn";
import { fakeTraceSource } from "./support";

const PROJECT = "p1";

function turn(ask: string): TurnContent {
  return {
    ask,
    messages: [],
    toolCalls: [],
    conversation: { earlier: [], ask, answer: "done" },
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, index) => `t${index + 1}`);

test("a preview shows the first rows that a run would freeze now, and how many it finds", async () => {
  const loaded: string[] = [];
  const source = fakeTraceSource({
    lastTurns: async (_, limit) => ids(30).slice(0, limit),
    loadTurn: async (_, turnId) => {
      loaded.push(turnId);
      return turnId === "t2" ? null : turn(`ask ${turnId}`);
    },
  });
  const preview = await previewDataset(PROJECT, { kind: "last_traces", limit: 20 }, source);
  assert.ok(preview.ok);
  assert.equal(preview.found, 20);
  // The first rows only: a preview does not read each turn.
  assert.equal(loaded.length, PREVIEW_ROWS);
  assert.deepEqual(
    preview.rows.slice(0, 2).map(({ turnId, input }) => [turnId, input]),
    [
      ["t1", JSON.stringify({ message: "ask t1" })],
      ["t3", JSON.stringify({ message: "ask t3" })],
    ],
  );
  assert.equal(preview.rows.length, PREVIEW_ROWS - 1);
});

test("a preview refuses as a run would: no captured text, a failed query, too many rows", async () => {
  const closed = await previewDataset(
    PROJECT,
    { kind: "last_traces", limit: 5 },
    fakeTraceSource({ readContent: async () => false }),
  );
  assert.deepEqual(closed.ok ? null : closed.reason, "no_content_access");

  const failed = await previewDataset(
    PROJECT,
    { kind: "rql", text: "SELECT nope", limit: 5 },
    fakeTraceSource({ runRql: async () => ({ ok: false, message: "No column nope." }) }),
  );
  assert.equal(failed.ok ? null : failed.reason, "query_failed");
  assert.match(failed.ok ? "" : failed.message, /No column nope/);

  const many = await previewDataset(
    PROJECT,
    { kind: "rql", text: "SELECT trace_id FROM traces", limit: 2 },
    fakeTraceSource({
      runRql: async () => ({
        ok: true,
        columns: [{ name: "trace_id" }],
        rows: [["a"], ["b"], ["c"]],
      }),
      turnsOfTraces: async (_, traceIds) => new Map(traceIds.map((id) => [id, `turn-${id}`])),
    }),
  );
  assert.equal(many.ok ? null : many.reason, "too_many_rows");
});

test("a query that finds no turn says so", async () => {
  const empty = await previewDataset(PROJECT, { kind: "auto", taskId: null, limit: 5 }, fakeTraceSource());
  assert.equal(empty.ok ? null : empty.reason, "no_rows");
});

test("a fixed dataset has no query to preview", async () => {
  const fixed = await previewDataset(PROJECT, { kind: "fixed" }, fakeTraceSource());
  assert.equal(fixed.ok ? null : fixed.reason, "not_a_query");
});

test("a long input is cut", async () => {
  const preview = await previewDataset(
    PROJECT,
    { kind: "task_traces", taskId: "task-1", limit: 1 },
    fakeTraceSource({
      taskTurns: async () => ["t1"],
      loadTurn: async () => turn("x".repeat(1_000)),
    }),
  );
  assert.ok(preview.ok);
  const [row] = preview.rows;
  assert.ok(row && row.input !== null && row.input.length <= 161);
  assert.ok(row?.input?.endsWith("…"));
});
