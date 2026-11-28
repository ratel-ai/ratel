import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDataset } from "../datasets";
import { datasetQuerySchema } from "../domain/dataset";
import type { TurnContent } from "../domain/from-turn";
import type { RqlTable, TraceSource } from "../ports/trace-source";

const PROJECT = "p1";
const MAY_COPY = { mayCopyContent: true };

function turn(ask: string, answer = "done"): TurnContent {
  return {
    ask,
    messages: [],
    toolCalls: [
      { name: "refund_order", arguments: { id: "A1" }, result: { ok: true }, earlier: false },
    ] as unknown as TurnContent["toolCalls"],
    conversation: { earlier: [{ role: "user", text: "hi" }], ask, answer },
  };
}

function fakeSource(over: Partial<TraceSource> = {}): TraceSource & { calls: string[] } {
  const calls: string[] = [];
  const turns = new Map(["t1", "t2", "t3"].map((id) => [id, turn(`ask ${id}`)]));
  return {
    calls,
    readContent: async () => true,
    lastTurns: async (_, limit) => {
      calls.push(`last:${limit}`);
      return ["t1", "t2", "t3"].slice(0, limit);
    },
    taskTurns: async (_, taskId, limit) => {
      calls.push(`task:${taskId}:${limit}`);
      return ["t2"];
    },
    runRql: async (_, text): Promise<RqlTable> => {
      calls.push(`rql:${text}`);
      return {
        ok: true,
        columns: [{ name: "cost" }, { name: "trace_id" }],
        rows: [
          [1, "tr-3"],
          [2, "tr-1"],
          [3, "tr-3"],
          [4, "tr-none"],
        ],
      };
    },
    turnsOfTraces: async (_, traceIds) =>
      new Map(traceIds.flatMap((id) => (id === "tr-none" ? [] : [[id, id.replace("tr-", "t")]]))),
    chooseTurns: async (_, taskId, limit) => {
      calls.push(`auto:${taskId}:${limit}`);
      return ["t3", "t1"];
    },
    loadTurn: async (_, turnId) => turns.get(turnId) ?? null,
    readOnlyTools: async () => new Set<string>(),
    ...over,
  };
}

const query = (raw: unknown) => datasetQuerySchema.parse(raw);

test("last N traces resolve the newest turns, each with a frozen copy of what a run needs", async () => {
  const source = fakeSource();
  const result = await resolveDataset(
    PROJECT,
    query({ kind: "last_traces", limit: 2 }),
    source,
    MAY_COPY,
  );
  assert.ok(result.ok);
  assert.deepEqual(source.calls, ["last:2"]);
  assert.deepEqual(
    result.rows.map(({ turnId }) => turnId),
    ["t1", "t2"],
  );
  const [first] = result.rows;
  assert.deepEqual(first?.content, {
    input: { message: "ask t1" },
    earlierTurns: [{ role: "user", text: "hi" }],
    toolFixtures: [{ tool: "refund_order", arguments: { id: "A1" }, result: { ok: true } }],
    expectedOutput: null,
  });
  assert.equal(first?.sourceOutput, "done");
});

test("the traces of a task resolve through the task", async () => {
  const source = fakeSource();
  const result = await resolveDataset(
    PROJECT,
    query({ kind: "task_traces", taskId: "refunds" }),
    source,
    MAY_COPY,
  );
  assert.ok(result.ok);
  assert.deepEqual(source.calls, ["task:refunds:50"]);
  assert.deepEqual(
    result.rows.map(({ turnId }) => turnId),
    ["t2"],
  );
});

test("an RQL query resolves the distinct turns of its trace_id column, in its order", async () => {
  const source = fakeSource();
  const result = await resolveDataset(
    PROJECT,
    query({ kind: "rql", text: "select trace_id from traces" }),
    source,
    MAY_COPY,
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map(({ turnId }) => turnId),
    ["t3", "t1"],
  );
});

test("an RQL query with no trace_id column, or that fails, is refused with the reason", async () => {
  const noColumn = fakeSource({
    runRql: async () => ({ ok: true, columns: [{ name: "cost" }], rows: [[1]] }),
  });
  const refused = await resolveDataset(
    PROJECT,
    query({ kind: "rql", text: "select 1" }),
    noColumn,
    MAY_COPY,
  );
  assert.deepEqual(refused.ok ? null : refused.reason, "query_failed");
  assert.match(refused.ok ? "" : refused.message, /trace_id/);
  const failing = fakeSource({ runRql: async () => ({ ok: false, message: "unknown table x" }) });
  const failed = await resolveDataset(
    PROJECT,
    query({ kind: "rql", text: "select" }),
    failing,
    MAY_COPY,
  );
  assert.match(failed.ok ? "" : failed.message, /unknown table x/);
});

test("an RQL query that finds more turns than the limit is refused with the reason", async () => {
  const source = fakeSource();
  const result = await resolveDataset(
    PROJECT,
    query({ kind: "rql", text: "select trace_id from traces", limit: 1 }),
    source,
    MAY_COPY,
  );
  assert.equal(result.ok ? null : result.reason, "too_many_rows");
  assert.match(result.ok ? "" : result.message, /more than 1 turn/);
});

test("let Ratel choose takes the chosen turns, with the task of the rule", async () => {
  const source = fakeSource();
  const result = await resolveDataset(
    PROJECT,
    query({ kind: "auto", taskId: "refunds", limit: 5 }),
    source,
    MAY_COPY,
  );
  assert.ok(result.ok);
  assert.deepEqual(source.calls, ["auto:refunds:5"]);
  assert.deepEqual(
    result.rows.map(({ turnId }) => turnId),
    ["t3", "t1"],
  );
});

test("a source that gives more turns than the limit is cut to the limit", async () => {
  const source = fakeSource({ chooseTurns: async () => ["t1", "t2", "t3"] });
  const result = await resolveDataset(PROJECT, query({ kind: "auto", limit: 2 }), source, MAY_COPY);
  assert.ok(result.ok);
  assert.equal(result.rows.length, 2);
});

test("a project that does not store content cannot build rows from traces, and the refusal says so", async () => {
  const source = fakeSource({ readContent: async () => false });
  const result = await resolveDataset(PROJECT, query({ kind: "last_traces" }), source, MAY_COPY);
  assert.equal(result.ok ? null : result.reason, "no_content_access");
  assert.match(result.ok ? "" : result.message, /captured text/);
  assert.deepEqual(source.calls, []);
});

test("a caller that may not copy captured text gets no row, and no trace is read", async () => {
  const source = fakeSource();
  const result = await resolveDataset(PROJECT, query({ kind: "last_traces" }), source, {
    mayCopyContent: false,
  });
  assert.equal(result.ok ? null : result.reason, "no_content_access");
  assert.match(result.ok ? "" : result.message, /content permission/);
  assert.deepEqual(source.calls, []);
});

test("a turn with no captured input is left out, and no row at all is refused", async () => {
  const source = fakeSource({
    loadTurn: async (_, turnId) => (turnId === "t1" ? turn("ask t1") : null),
  });
  const some = await resolveDataset(PROJECT, query({ kind: "last_traces" }), source, MAY_COPY);
  assert.deepEqual(some.ok && some.rows.map(({ turnId }) => turnId), ["t1"]);
  const none = await resolveDataset(
    PROJECT,
    query({ kind: "last_traces" }),
    fakeSource({ lastTurns: async () => [] }),
    MAY_COPY,
  );
  assert.equal(none.ok ? null : none.reason, "no_rows");
});

test("a fixed dataset is not resolved", async () => {
  const result = await resolveDataset(PROJECT, query({ kind: "fixed" }), fakeSource(), MAY_COPY);
  assert.equal(result.ok ? null : result.reason, "not_a_query");
});
