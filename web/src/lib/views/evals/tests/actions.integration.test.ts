import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import type { EvalBody } from "../actions";
import {
  type ActionDeps,
  addDatasetRows,
  createDataset,
  createEval,
  editEval,
  previewQuery,
  removeDatasetRow,
  startRun,
} from "../actions";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { currentVersion } from "../domain/eval";
import type { TurnContent } from "../domain/from-turn";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
} from "./support";

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const TURN_1 = "a1111111-1111-4111-8111-111111111111";
const TURN_2 = "a2222222-2222-4222-8222-222222222222";
const ACTOR = { by: "user_1", mayReadContent: true };
const NO_TEXT = { by: "key:1", mayReadContent: false };
const VERSION: SandboxVersionSummary = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId: PROJECT_ID,
  sandboxId: "77777777-7777-4777-8777-777777777777",
  name: "support-demo",
  git: { commit: "b".repeat(40), dirty: false },
  status: "ready",
  createdAt: new Date(),
  tools: [],
  params: [{ name: "model", type: "string", default: null, description: null, options: [] }],
};

function turn(ask: string): TurnContent {
  return { ask, messages: [], toolCalls: [], conversation: { earlier: [], ask, answer: "ok" } };
}

async function setup() {
  const { db } = await createEvalsDb();
  const deps: ActionDeps = {
    cases: createDrizzleCaseStore(db),
    evals: createDrizzleEvalStore(db),
    datasets: createDrizzleDatasetStore(db),
    traces: fakeTraceSource({
      lastTurns: async (_, limit) => [TURN_1, TURN_2].slice(0, limit),
      loadTurn: async (_, turnId) => turn(`ask ${turnId.slice(0, 2)}`),
    }),
    library: fakeLibrary(),
    experiments: createDrizzleExperimentStore(db),
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [VERSION],
      getVersion: async (_, id) => (id === VERSION.id ? VERSION : null),
      startRun: async () => {
        throw new Error("no trial starts in these tests");
      },
      getRun: async () => null,
    },
    judge: {} as ActionDeps["judge"],
    now: () => new Date("2026-11-27T10:00:00Z"),
    turnRow: async (projectId, turnId) =>
      projectId === PROJECT_ID && turnId === TURN_1
        ? {
            name: "Case from a turn",
            content: content({ input: "refund A200" }),
            sourceOutput: "Done.",
          }
        : null,
  };
  return { db, deps };
}

const EVAL: EvalBody = {
  name: "Refunds",
  taskId: null,
  sandboxName: "support-demo",
  sandboxVersionId: null,
  dataset: { query: { kind: "last_traces", limit: 5 } },
  params: { model: "sonnet" },
  matrix: {},
  trials: 1,
  scorers: [
    {
      id: "says",
      name: "Output contains: refund",
      gating: true,
      ref: { source: "predefined", key: "output_contains", settings: { value: "refund" } },
    },
  ],
};

test("a fixed dataset from chosen turns copies each turn; without captured text it refuses", async () => {
  const { deps } = await setup();
  const made = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Refund asks", description: null, query: { kind: "fixed" }, turnIds: [TURN_1] },
    deps,
  );
  assert.ok(made.ok);
  assert.equal(made.rows, 1);
  const [row] = await deps.datasets.rows(PROJECT_ID, made.dataset.id);
  assert.equal(row?.versions[0]?.sourceTurnId, TURN_1);
  assert.equal(row?.name, "Turn a1111111");

  const closed = await createDataset(
    PROJECT_ID,
    NO_TEXT,
    { name: "Closed", description: null, query: { kind: "fixed" }, turnIds: [TURN_1] },
    deps,
  );
  assert.equal(closed.ok ? null : closed.reason, "no_content_access");
  // Nothing was made.
  assert.equal((await deps.datasets.list(PROJECT_ID)).length, 1);
  const unknown = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Unknown", description: null, query: { kind: "fixed" }, turnIds: [TURN_2] },
    deps,
  );
  assert.equal(unknown.ok ? null : unknown.reason, "not_found");
  const queryWithRows = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Q", description: null, query: { kind: "last_traces", limit: 5 }, turnIds: [TURN_1] },
    deps,
  );
  assert.equal(queryWithRows.ok ? null : queryWithRows.reason, "invalid");
});

test("rows are added and removed in the dataset of the project only", async () => {
  const { deps } = await setup();
  const made = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Typed", description: null, query: { kind: "fixed" } },
    deps,
  );
  assert.ok(made.ok);
  const added = await addDatasetRows(
    PROJECT_ID,
    made.dataset.id,
    ACTOR,
    [
      { kind: "values", name: "Order A1", values: { order: "A1" }, expectedOutput: null },
      { kind: "turn", turnId: TURN_1 },
    ],
    deps,
  );
  assert.ok(added.ok);
  assert.equal(added.rows.length, 2);
  // Another project does not reach the dataset.
  const other = await addDatasetRows(
    OTHER_PROJECT_ID,
    made.dataset.id,
    ACTOR,
    [{ kind: "values", name: "X", values: { x: 1 }, expectedOutput: null }],
    deps,
  );
  assert.equal(other.ok ? null : other.reason, "not_found");
  const [first] = added.rows;
  assert.ok(first);
  const removedElsewhere = await removeDatasetRow(
    OTHER_PROJECT_ID,
    made.dataset.id,
    first.rowId,
    deps,
  );
  assert.equal(removedElsewhere.ok ? null : removedElsewhere.reason, "not_found");
  assert.ok((await removeDatasetRow(PROJECT_ID, made.dataset.id, first.rowId, deps)).ok);
  assert.equal((await deps.datasets.rows(PROJECT_ID, made.dataset.id)).length, 1);
});

test("a preview needs captured text", async () => {
  const { deps } = await setup();
  const closed = await previewQuery(PROJECT_ID, NO_TEXT, { kind: "last_traces", limit: 5 }, deps);
  assert.equal(closed.ok ? null : closed.reason, "no_content_access");
  const open = await previewQuery(PROJECT_ID, ACTOR, { kind: "last_traces", limit: 5 }, deps);
  assert.ok(open.ok);
  assert.equal(open.found, 2);
});

test("an eval with a query made in the dialog gets a dataset named after it, and library scorers", async () => {
  const { deps } = await setup();
  await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Refunds", description: null, query: { kind: "fixed" } },
    deps,
  );
  const made = await createEval(PROJECT_ID, ACTOR, EVAL, deps);
  assert.ok(made.ok);
  const version = currentVersion(made.eval);
  const dataset = await deps.datasets.get(PROJECT_ID, version.datasetId);
  assert.equal(dataset?.name, "Refunds (2)");
  assert.deepEqual(dataset?.query, { kind: "last_traces", limit: 5 });
  assert.equal(version.sandboxName, "support-demo");
  assert.deepEqual(version.params, { model: "sonnet" });
  assert.deepEqual(version.scorers[0]?.definition, {
    kind: "check",
    config: { path: "output", op: "contains", value: "refund" },
  });
  const again = await createEval(PROJECT_ID, ACTOR, EVAL, deps);
  assert.equal(again.ok ? null : again.reason, "name_taken");
  // A dataset of another project is not found.
  const otherDataset = await createDataset(
    OTHER_PROJECT_ID,
    ACTOR,
    { name: "Theirs", description: null, query: { kind: "fixed" } },
    deps,
  );
  assert.ok(otherDataset.ok);
  const foreign = await createEval(
    PROJECT_ID,
    ACTOR,
    { ...EVAL, name: "Foreign", dataset: { datasetId: otherDataset.dataset.id } },
    deps,
  );
  assert.equal(foreign.ok ? null : foreign.reason, "not_found");
  // An edit adds a version and keeps the eval.
  const edited = await editEval(
    PROJECT_ID,
    made.eval.id,
    { ...ACTOR, now: new Date() },
    { ...EVAL, trials: 2, base: version.id },
    deps,
  );
  assert.ok(edited.ok);
  assert.equal(currentVersion(edited.eval).number, 2);
  assert.equal(currentVersion(edited.eval).trials, 2);
  const stale = await editEval(
    PROJECT_ID,
    made.eval.id,
    { ...ACTOR, now: new Date() },
    { ...EVAL, trials: 3, base: version.id },
    deps,
  );
  assert.equal(stale.ok ? null : stale.reason, "changed");
});

test("a run records what it changed: rows from turns, scorers, params, a matrix", async () => {
  const { deps } = await setup();
  const fixed = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Refund asks", description: null, query: { kind: "fixed" }, turnIds: [TURN_1] },
    deps,
  );
  assert.ok(fixed.ok);
  const made = await createEval(
    PROJECT_ID,
    ACTOR,
    { ...EVAL, dataset: { datasetId: fixed.dataset.id } },
    deps,
  );
  assert.ok(made.ok);
  const plain = await startRun(SUBJECT, made.eval.id, ACTOR, {}, deps);
  assert.ok(plain.ok);
  assert.deepEqual(plain.experiment.changes, {});
  assert.equal(plain.experiment.caseVersions.length, 1);

  const changed = await startRun(
    SUBJECT,
    made.eval.id,
    ACTOR,
    {
      name: "Haiku and Opus",
      rows: { kind: "last_traces", limit: 2 },
      params: { model: "haiku" },
      matrix: { model: ["haiku", "opus"] },
      scorers: [
        {
          id: "safe",
          name: "Answer is safe",
          gating: true,
          ref: { source: "predefined", key: "is_safe", settings: {} },
        },
      ],
    },
    deps,
  );
  assert.ok(changed.ok);
  const { experiment } = changed;
  assert.equal(experiment.name, "Haiku and Opus");
  assert.deepEqual(experiment.changes, {
    addedRows: 2,
    scorers: true,
    params: { model: "haiku" },
    matrix: { model: ["haiku", "opus"] },
  });
  assert.equal(experiment.variants.length, 2);
  assert.equal(experiment.caseVersions.length, 3);
  // The rows of one run are not rows of the dataset.
  assert.equal((await deps.datasets.rows(PROJECT_ID, fixed.dataset.id)).length, 1);

  const closed = await startRun(
    SUBJECT,
    made.eval.id,
    NO_TEXT,
    { rows: { kind: "turns", turnIds: [TURN_1] } },
    deps,
  );
  assert.equal(closed.ok ? null : closed.reason, "no_content_access");
  const elsewhere = await startRun(
    { ...SUBJECT, projectId: OTHER_PROJECT_ID },
    made.eval.id,
    ACTOR,
    {},
    deps,
  );
  assert.equal(elsewhere.ok ? null : elsewhere.reason, "not_found");
});

test("the scorers of one run follow the rules of an eval: at most five judges, unique ids", async () => {
  const { deps } = await setup();
  const fixed = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "Rows", description: null, query: { kind: "fixed" }, turnIds: [TURN_1] },
    deps,
  );
  assert.ok(fixed.ok);
  const made = await createEval(
    PROJECT_ID,
    ACTOR,
    { ...EVAL, dataset: { datasetId: fixed.dataset.id } },
    deps,
  );
  assert.ok(made.ok);
  const judge = (n: number) => ({
    id: `judge-${n}`,
    name: `Safe ${n}`,
    gating: true,
    ref: { source: "predefined" as const, key: "is_safe" as const, settings: {} },
  });
  const six = await startRun(
    SUBJECT,
    made.eval.id,
    ACTOR,
    { scorers: Array.from({ length: 6 }, (_, n) => judge(n)) },
    deps,
  );
  assert.equal(six.ok ? null : six.reason, "invalid_scorers");
  assert.match(six.ok ? "" : six.message, /at most 5 judges/);
  const twice = await startRun(
    SUBJECT,
    made.eval.id,
    ACTOR,
    { scorers: [judge(1), judge(1)] },
    deps,
  );
  assert.equal(twice.ok ? null : twice.reason, "invalid_scorers");
});

test("an RQL dataset is refused at create, preview and eval save when RQL (customMonitoring) is off", async () => {
  const { deps } = await setup();
  const off: ActionDeps = { ...deps, traces: { ...deps.traces, rqlEnabled: async () => false } };
  const rql = { kind: "rql" as const, text: "select trace_id from traces", limit: 5 };
  const made = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "By RQL", description: null, query: rql },
    off,
  );
  assert.equal(made.ok ? null : made.reason, "rql_off");
  assert.deepEqual(await deps.datasets.list(PROJECT_ID), []);
  const preview = await previewQuery(PROJECT_ID, ACTOR, rql, off);
  assert.equal(preview.ok ? null : preview.reason, "rql_off");
  const saved = await createEval(PROJECT_ID, ACTOR, { ...EVAL, dataset: { query: rql } }, off);
  assert.equal(saved.ok ? null : saved.reason, "rql_off");
  // With RQL on, the same dataset is made.
  const on = await createDataset(
    PROJECT_ID,
    ACTOR,
    { name: "By RQL", description: null, query: rql },
    deps,
  );
  assert.ok(on.ok);
});
