import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import {
  type DatasetsApiDeps,
  handleAddDatasetRows,
  handleCreateDataset,
  handlePreviewDataset,
  handleRemoveDatasetRow,
} from "../datasets-api";
import { currentVersion } from "../domain/case";
import type { TurnContent } from "../domain/from-turn";
import type { TraceSource } from "../ports/trace-source";
import { createEvalsDb, fakeTraceSource, ORGANIZATION_ID, PROJECT_ID } from "./support";

const TURN_1 = "a1111111-1111-4111-8111-111111111111";
const TURN_2 = "a2222222-2222-4222-8222-222222222222";
const NO_INPUT = "a3333333-3333-4333-8333-333333333333";
const TURNS: Record<string, TurnContent> = {
  [TURN_1]: turn("refund A200", "Refunded."),
  [TURN_2]: turn("where is A300", "On its way."),
  [NO_INPUT]: { ask: null, messages: [], toolCalls: [] },
};

function turn(ask: string, answer: string): TurnContent {
  return {
    ask: null,
    messages: [
      { id: "1", role: "user", text: ask },
      { id: "2", role: "assistant", text: answer },
    ],
    toolCalls: [],
  };
}

async function setup(over: Partial<TraceSource> = {}) {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const source = fakeTraceSource({
    loadTurn: async (_projectId, turnId) => TURNS[turnId] ?? null,
    lastTurns: async (_projectId, limit) => [TURN_1, TURN_2].slice(0, limit),
    ...over,
  });
  const deps = (more: Partial<DatasetsApiDeps> = {}): DatasetsApiDeps => ({
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT_ID
        ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role: "member" }
        : null,
    enabled: async () => true,
    isRestricted: async () => false,
    datasets: () => datasets,
    source: () => source,
    ...more,
  });
  return { datasets, deps };
}

function request(body: unknown): Request {
  return new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
}

async function answer(response: Promise<Response>) {
  const done = await response;
  return { status: done.status, body: await done.json() };
}

test("a fixed dataset is made empty or from chosen turns, each row a trace row", async () => {
  const { datasets, deps } = await setup();
  const empty = await answer(handleCreateDataset(request({ name: "Empty" }), PROJECT_ID, deps()));
  assert.equal(empty.status, 201);
  assert.equal(empty.body.dataset.query.kind, "fixed");
  assert.equal(empty.body.rows, 0);
  const chosen = await answer(
    handleCreateDataset(
      request({ name: "Chosen", description: "Two asks", turnIds: [TURN_1, TURN_2, TURN_1] }),
      PROJECT_ID,
      deps(),
    ),
  );
  assert.equal(chosen.status, 201);
  assert.equal(chosen.body.rows, 2);
  const rows = await datasets.rows(PROJECT_ID, chosen.body.dataset.datasetId);
  assert.deepEqual(
    rows.map((row) => currentVersion(row)?.sourceTurnId).sort(),
    [TURN_1, TURN_2].sort(),
  );
  const taken = await answer(handleCreateDataset(request({ name: "Empty" }), PROJECT_ID, deps()));
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "name_taken");
});

test("a query dataset keeps its query, and takes no chosen turn", async () => {
  const { deps } = await setup();
  for (const query of [
    { kind: "last_traces", limit: 20 },
    { kind: "task_traces", taskId: "refunds" },
    { kind: "rql", text: "select trace_id from traces" },
    { kind: "auto" },
  ]) {
    const made = await answer(
      handleCreateDataset(request({ name: query.kind, query }), PROJECT_ID, deps()),
    );
    assert.equal(made.status, 201, query.kind);
    assert.equal(made.body.dataset.query.kind, query.kind);
  }
  const refused = await answer(
    handleCreateDataset(
      request({ name: "bad", query: { kind: "auto" }, turnIds: [TURN_1] }),
      PROJECT_ID,
      deps(),
    ),
  );
  assert.equal(refused.status, 400);
  const tooMany = await answer(
    handleCreateDataset(
      request({ name: "big", query: { kind: "last_traces", limit: 501 } }),
      PROJECT_ID,
      deps(),
    ),
  );
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /at most 500 rows/);
});

test("rows are added from turns or typed values, and removed", async () => {
  const { datasets, deps } = await setup();
  const made = await answer(handleCreateDataset(request({ name: "Rows" }), PROJECT_ID, deps()));
  const id = made.body.dataset.datasetId;
  const fromTurn = await answer(
    handleAddDatasetRows(request({ turnIds: [TURN_1] }), PROJECT_ID, id, deps()),
  );
  assert.equal(fromTurn.status, 201);
  const typed = await answer(
    handleAddDatasetRows(
      request({ row: { name: "Typed", input: "cancel B1", expectedOutput: "Cancelled." } }),
      PROJECT_ID,
      id,
      deps(),
    ),
  );
  assert.equal(typed.status, 201);
  const rows = await datasets.rows(PROJECT_ID, id);
  assert.equal(rows.length, 2);
  const value = rows.find(({ name }) => name === "Typed");
  // Text is the message of the agent, as a row from a trace turn has it.
  assert.deepEqual(value && currentVersion(value)?.input, { message: "cancel B1" });
  assert.equal(value && currentVersion(value)?.expectedOutput, "Cancelled.");
  const json = await answer(
    handleAddDatasetRows(
      request({ row: { name: "JSON", input: '{"order": "A1", "amount": 3}' } }),
      PROJECT_ID,
      id,
      deps(),
    ),
  );
  assert.equal(json.status, 201);
  const jsonRow = (await datasets.rows(PROJECT_ID, id)).find(({ name }) => name === "JSON");
  assert.deepEqual(jsonRow && currentVersion(jsonRow)?.input, { order: "A1", amount: 3 });
  const noInput = await answer(
    handleAddDatasetRows(request({ turnIds: [NO_INPUT] }), PROJECT_ID, id, deps()),
  );
  assert.equal(noInput.status, 422);
  assert.equal(noInput.body.error, "no_input");
  const missing = await answer(
    handleAddDatasetRows(request({ turnIds: [crypto.randomUUID()] }), PROJECT_ID, id, deps()),
  );
  assert.equal(missing.status, 404);
  assert.ok(value);
  const removed = await handleRemoveDatasetRow(PROJECT_ID, id, value.id, deps());
  assert.equal(removed.status, 200);
  assert.equal((await datasets.rows(PROJECT_ID, id)).length, 2);
  const again = await handleRemoveDatasetRow(PROJECT_ID, id, value.id, deps());
  assert.equal(again.status, 404);
  const query = await answer(
    handleCreateDataset(request({ name: "Q", query: { kind: "last_traces" } }), PROJECT_ID, deps()),
  );
  const notFixed = await answer(
    handleAddDatasetRows(
      request({ turnIds: [TURN_1] }),
      PROJECT_ID,
      query.body.dataset.datasetId,
      deps(),
    ),
  );
  assert.equal(notFixed.status, 409);
  assert.equal(notFixed.body.error, "dataset_not_fixed");
});

test("rows from turns need content access, and writes need a member outside support", async () => {
  const { deps } = await setup({ readContent: async () => false });
  const refused = await answer(
    handleCreateDataset(request({ name: "x", turnIds: [TURN_1] }), PROJECT_ID, deps()),
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "no_content_access");
  const restricted = await answer(
    handleCreateDataset(
      request({ name: "y" }),
      PROJECT_ID,
      deps({ isRestricted: async () => true }),
    ),
  );
  assert.equal(restricted.status, 403);
  assert.equal(restricted.body.message, SUPPORT_SESSION_RESTRICTED_MESSAGE);
  const off = await handleCreateDataset(
    request({ name: "z" }),
    PROJECT_ID,
    deps({ enabled: async () => false }),
  );
  assert.equal(off.status, 404);
  const other = await handleRemoveDatasetRow(
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    deps(),
  );
  assert.equal(other.status, 404);
});

test("a preview resolves a query now, at most ten rows, and says why it cannot", async () => {
  const { deps } = await setup();
  const preview = await answer(
    handlePreviewDataset(
      request({ query: { kind: "last_traces", limit: 50 } }),
      PROJECT_ID,
      deps(),
    ),
  );
  assert.equal(preview.status, 200);
  assert.deepEqual(
    preview.body.rows.map(({ turnId, input, output }: Record<string, string>) => [
      turnId,
      input,
      output,
    ]),
    [
      [TURN_1, "refund A200", "Refunded."],
      [TURN_2, "where is A300", "On its way."],
    ],
  );
  assert.equal(preview.body.limit, 50);
  const fixed = await answer(
    handlePreviewDataset(request({ query: { kind: "fixed" } }), PROJECT_ID, deps()),
  );
  assert.equal(fixed.status, 400);
  const { deps: failing } = await setup({
    runRql: async () => ({ ok: false, message: "no such column: tracе" }),
  });
  const failed = await answer(
    handlePreviewDataset(
      request({ query: { kind: "rql", text: "select x from traces" } }),
      PROJECT_ID,
      failing(),
    ),
  );
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, "query_failed");
});

test("a Playground run is saved as a row with its input, into a dataset that exists or a new one", async () => {
  const { datasets, deps } = await setup();
  const saved = {
    name: "Where is order 7",
    content: {
      input: { message: "Where is my order 7?" },
      expectedOutput: "Order 7 ships tomorrow.",
    },
  };
  const made = await answer(
    handleCreateDataset(request({ name: "From the Playground", case: saved }), PROJECT_ID, deps()),
  );
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.rows, 1);
  const id = made.body.dataset.datasetId;
  const added = await answer(
    handleAddDatasetRows(request({ case: saved }), PROJECT_ID, id, deps()),
  );
  assert.equal(added.status, 201);
  const rows = await datasets.rows(PROJECT_ID, id);
  assert.equal(rows.length, 2);
  const version = rows[0] && currentVersion(rows[0]);
  assert.deepEqual(version?.input, { message: "Where is my order 7?" });
  assert.equal(version?.expectedOutput, "Order 7 ships tomorrow.");
  assert.equal(version?.sourceTurnId, null);
  const empty = await answer(
    handleAddDatasetRows(
      request({ case: { name: "x", content: { input: null } } }),
      PROJECT_ID,
      id,
      deps(),
    ),
  );
  assert.equal(empty.status, 422);
});
