import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { currentVersion } from "../domain/case";
import { datasetQuerySchema, rowKindOf } from "../domain/dataset";
import { datasetOf } from "../domain/eval";
import type { TurnContent } from "../domain/from-turn";
import { type ExperimentDeps, startExperiment } from "../experiments";
import type { TraceSource } from "../ports/trace-source";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  seedEval,
} from "./support";

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const TURN_1 = "a1111111-1111-4111-8111-111111111111";
const TURN_2 = "a2222222-2222-4222-8222-222222222222";
const VERSION: SandboxVersionSummary = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId: PROJECT_ID,
  sandboxId: "77777777-7777-4777-8777-777777777777",
  name: "support-demo",
  git: { commit: "b".repeat(40), dirty: false },
  status: "ready",
  createdAt: new Date(),
  tools: [],
  params: [],
};

function turn(ask: string): TurnContent {
  return { ask, messages: [], toolCalls: [], conversation: null };
}

test("a fixed dataset holds trace rows and value rows, and counts them", async () => {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const made = await datasets.create({
    projectId: PROJECT_ID,
    name: "Refund asks",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  assert.notEqual(made, "name_taken");
  if (made === "name_taken") return;
  const rows = await datasets.addRows(
    PROJECT_ID,
    made.id,
    [
      {
        kind: "trace",
        name: "From a turn",
        turnId: TURN_1,
        content: content({ earlierTurns: [{ role: "user", text: "hi" }] }),
        sourceOutput: "Refunded.",
      },
      {
        kind: "values",
        name: "Typed",
        labels: ["smoke"],
        row: { values: { order: "A200", amount: 12.5 }, expectedOutput: "No refund." },
      },
    ],
    "user_1",
  );
  assert.ok(Array.isArray(rows));
  const stored = await datasets.rows(PROJECT_ID, made.id);
  const byName = new Map(stored.map((row) => [row.name, row]));
  const trace = byName.get("From a turn");
  const values = byName.get("Typed");
  assert.equal(trace && rowKindOf(currentVersion(trace) ?? { sourceTurnId: null }), "trace");
  assert.equal(currentVersion(trace ?? { versions: [] })?.sourceOutput, "Refunded.");
  assert.deepEqual(currentVersion(values ?? { versions: [] })?.input, {
    order: "A200",
    amount: 12.5,
  });
  assert.equal(currentVersion(values ?? { versions: [] })?.expectedOutput, "No refund.");
  assert.deepEqual(values?.labels, ["smoke"]);
  assert.equal(values?.evalId, null);
  const [listed] = await datasets.list(PROJECT_ID);
  assert.equal(listed?.rowCount, 2);
  assert.equal(
    await datasets.create({
      projectId: PROJECT_ID,
      name: "Refund asks",
      description: null,
      query: { kind: "fixed" },
      createdBy: "user_1",
    }),
    "name_taken",
  );
});

test("each query kind keeps its settings, and holds no row of its own", async () => {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const queries = [
    { kind: "last_traces", limit: 20 },
    { kind: "task_traces", taskId: "refunds" },
    { kind: "rql", text: "select trace_id from traces where has_error", limit: 10 },
    { kind: "auto" },
  ].map((raw) => datasetQuerySchema.parse(raw));
  for (const [index, query] of queries.entries()) {
    const made = await datasets.create({
      projectId: PROJECT_ID,
      name: `q${index}`,
      description: "a query",
      query,
      createdBy: "user_1",
    });
    if (made === "name_taken") throw new Error("taken");
    assert.deepEqual((await datasets.get(PROJECT_ID, made.id))?.query, query);
    const added = await datasets.addRows(
      PROJECT_ID,
      made.id,
      [{ kind: "values", name: "x", row: { values: { a: 1 }, expectedOutput: null } }],
      "user_1",
    );
    assert.equal(added, "not_fixed");
  }
  assert.equal(await datasets.addRows(PROJECT_ID, crypto.randomUUID(), [], "u"), "not_found");
});

test("a new eval gets a fixed dataset with its name, and its cases go there", async () => {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  await datasets.create({
    projectId: PROJECT_ID,
    name: "Refunds",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  const refunds = await seedEval(db);
  const own = await datasets.get(PROJECT_ID, datasetOf(refunds));
  assert.equal(own?.name, "Refunds (2)");
  assert.equal(own?.query.kind, "fixed");
  const cases = createDrizzleCaseStore(db);
  const made = await cases.create({
    projectId: PROJECT_ID,
    evalId: refunds.id,
    name: "ask",
    labels: [],
    content: content(),
    createdBy: "user_1",
  });
  assert.ok(typeof made !== "string");
  assert.equal(made.datasetId, datasetOf(refunds));
  assert.deepEqual(
    (await cases.list(PROJECT_ID, refunds.id)).map(({ id }) => id),
    [made.id],
  );
  assert.deepEqual(
    (await datasets.rows(PROJECT_ID, datasetOf(refunds))).map(({ id }) => id),
    [made.id],
  );
});

test("a run resolves a query dataset, freezes the rows that it found, and keeps them after a change", async () => {
  const { db, client } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const refunds = await seedEval(db);
  const query = await datasets.create({
    projectId: PROJECT_ID,
    name: "Last two",
    description: null,
    query: datasetQuerySchema.parse({ kind: "last_traces", limit: 2 }),
    createdBy: "user_1",
  });
  if (query === "name_taken") throw new Error("taken");
  // The version of the eval reads the query dataset.
  await client.query("update eval_definition_versions set dataset_id = $1 where eval_id = $2", [
    query.id,
    refunds.id,
  ]);
  let asks: Record<string, string> = { [TURN_1]: "refund A1", [TURN_2]: "refund A2" };
  const traces: TraceSource = fakeTraceSource({
    lastTurns: async (_, limit) => [TURN_1, TURN_2].slice(0, limit),
    loadTurn: async (_, turnId) => (asks[turnId] ? turn(asks[turnId]) : null),
  });
  const experiments = createDrizzleExperimentStore(db);
  const deps = depsOf(db, traces);
  const first = await startExperiment(SUBJECT, start(), deps);
  assert.ok(first.ok, first.ok ? "" : first.message);
  assert.equal(first.experiment.caseVersions.length, 2);
  assert.deepEqual(
    first.experiment.caseVersions.map(({ evalId, number }) => [evalId, number]),
    [
      [refunds.id, 1],
      [refunds.id, 1],
    ],
  );
  // The same turns with the same content: the same versions. A changed turn: a new version.
  asks = { ...asks, [TURN_2]: "refund A2 now" };
  const second = await startExperiment(SUBJECT, start(), deps);
  assert.ok(second.ok);
  const [one, two] = second.experiment.caseVersions;
  assert.equal(one?.versionId, first.experiment.caseVersions[0]?.versionId);
  assert.equal(two?.caseId, first.experiment.caseVersions[1]?.caseId);
  assert.equal(two?.number, 2);
  // The first run keeps what it froze.
  const [frozen] = await experiments.caseVersions([
    first.experiment.caseVersions[1]?.versionId ?? "",
  ]);
  assert.deepEqual(frozen?.input, { message: "refund A2" });
  assert.equal(frozen?.sourceTurnId, TURN_2);
  // The resolved rows are not rows of the dataset.
  assert.deepEqual(await datasets.rows(PROJECT_ID, query.id), []);
  assert.equal((await datasets.list(PROJECT_ID)).find(({ id }) => id === query.id)?.rowCount, 0);
});

test("a query dataset that cannot resolve refuses the run with its reason", async () => {
  const { db, client } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const refunds = await seedEval(db);
  const query = await datasets.create({
    projectId: PROJECT_ID,
    name: "Task",
    description: null,
    query: datasetQuerySchema.parse({ kind: "task_traces", taskId: "refunds" }),
    createdBy: "user_1",
  });
  if (query === "name_taken") throw new Error("taken");
  await client.query("update eval_definition_versions set dataset_id = $1 where eval_id = $2", [
    query.id,
    refunds.id,
  ]);
  const closed = await startExperiment(
    SUBJECT,
    start(),
    depsOf(db, fakeTraceSource({ readContent: async () => false })),
  );
  assert.equal(closed.ok ? null : closed.reason, "no_content_access");
  assert.match(closed.ok ? "" : closed.message, /"Task".*captured text/);
  const empty = await startExperiment(SUBJECT, start(), depsOf(db, fakeTraceSource()));
  assert.equal(empty.ok ? null : empty.reason, "no_cases");
  assert.equal((await createDrizzleExperimentStore(db).list(PROJECT_ID, 10)).length, 0);
});

function start() {
  return { sandboxVersion: "latest", params: {}, startedBy: "user_1" };
}

// biome-ignore lint/suspicious/noExplicitAny: the drizzle database of `createEvalsDb`
function depsOf(db: any, traces: TraceSource): ExperimentDeps {
  return {
    cases: createDrizzleCaseStore(db),
    evals: createDrizzleEvalStore(db),
    datasets: createDrizzleDatasetStore(db),
    traces,
    library: fakeLibrary(),
    experiments: createDrizzleExperimentStore(db),
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [VERSION],
      getVersion: async () => VERSION,
      startRun: async () => {
        throw new Error("no trial starts in these tests");
      },
      getRun: async () => null,
    },
    judge: {} as ExperimentDeps["judge"],
    now: () => new Date(),
  };
}

test("a removed row leaves the dataset and its count, and only a fixed dataset removes one", async () => {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const made = await datasets.create({
    projectId: PROJECT_ID,
    name: "Removals",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  if (made === "name_taken") throw new Error("taken");
  const added = await datasets.addRows(
    PROJECT_ID,
    made.id,
    [
      { kind: "values", name: "keep", row: { values: { a: 1 }, expectedOutput: null } },
      { kind: "values", name: "drop", row: { values: { a: 2 }, expectedOutput: null } },
    ],
    "user_1",
  );
  if (!Array.isArray(added)) throw new Error("not added");
  const drop = added[1];
  assert.ok(drop);
  const before = (await datasets.get(PROJECT_ID, made.id))?.updatedAt;
  assert.equal(await datasets.removeRow(OTHER_PROJECT_ID, made.id, drop.id), "not_found");
  assert.equal(await datasets.removeRow(PROJECT_ID, made.id, crypto.randomUUID()), "not_found");
  assert.equal(await datasets.removeRow(PROJECT_ID, made.id, drop.id), "removed");
  assert.equal(await datasets.removeRow(PROJECT_ID, made.id, drop.id), "not_found");
  assert.deepEqual(
    (await datasets.rows(PROJECT_ID, made.id)).map(({ name }) => name),
    ["keep"],
  );
  const [listed] = await datasets.list(PROJECT_ID);
  assert.equal(listed?.rowCount, 1);
  assert.ok((listed?.updatedAt.getTime() ?? 0) >= (before?.getTime() ?? Infinity));
  assert.equal(
    (await createDrizzleCaseStore(db).list(PROJECT_ID)).some(({ id }) => id === drop.id),
    false,
  );
  // The row stays for a run that froze it.
  assert.ok(await createDrizzleCaseStore(db).get(PROJECT_ID, drop.id));
  const query = await datasets.create({
    projectId: PROJECT_ID,
    name: "A query",
    description: null,
    query: datasetQuerySchema.parse({ kind: "last_traces" }),
    createdBy: "user_1",
  });
  if (query === "name_taken") throw new Error("taken");
  assert.equal(await datasets.removeRow(PROJECT_ID, query.id, drop.id), "not_fixed");
});
