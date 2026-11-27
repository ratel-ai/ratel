import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import type { Experiment } from "../domain/experiment";
import type { TurnContent } from "../domain/from-turn";
import type { ExperimentDeps } from "../experiments";
import type { ConsoleDeps } from "../experiments-api";
import { handleStartEvalRunByMember } from "../run-dialog-api";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  NO_REFUND,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedEval,
} from "./support";

const TURN = "a1111111-1111-4111-8111-111111111111";
const NEWEST = version("66666666-6666-4666-8666-666666666661", 3);
const OLDER = version("66666666-6666-4666-8666-666666666662", 2);
const ASK: TurnContent = {
  ask: null,
  messages: [
    { id: "1", role: "user", text: "where is A300" },
    { id: "2", role: "assistant", text: "On its way." },
  ],
  toolCalls: [],
};

function version(id: string, minute: number): SandboxVersionSummary {
  return {
    id,
    projectId: PROJECT_ID,
    sandboxId: "77777777-7777-4777-8777-777777777777",
    name: "support-demo",
    git: { commit: String(minute).repeat(40).slice(0, 40), dirty: false },
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 10, 27, 10, minute)),
    tools: [],
    params: [
      {
        name: "model",
        type: "enum",
        default: "small",
        description: null,
        options: ["small", "large"],
      },
    ],
  };
}

async function setup() {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const cases = createDrizzleCaseStore(db);
  const experiments = createDrizzleExperimentStore(db);
  const experimentDeps: ExperimentDeps = {
    cases,
    evals: createDrizzleEvalStore(db),
    datasets,
    traces: fakeTraceSource({
      loadTurn: async (_projectId, turnId) => (turnId === TURN ? ASK : null),
      lastTurns: async () => [TURN],
    }),
    library: fakeLibrary(),
    experiments,
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [NEWEST, OLDER],
      getVersion: async (_, id) => [NEWEST, OLDER].find((one) => one.id === id) ?? null,
      startRun: async () => {
        throw new Error("no trial starts in these tests");
      },
      getRun: async () => null,
    },
    judge: {} as ExperimentDeps["judge"],
    now: () => new Date(),
  };
  const advanced: Experiment[] = [];
  const deps: ConsoleDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT_ID
        ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role: "member" }
        : null,
    enabled: async () => true,
    isRestricted: async () => false,
    experiments: () => experimentDeps,
    advance: (experiment) => void advanced.push(experiment),
    track: async () => {},
    publicUrl: (path) => `http://localhost${path}`,
    baseline: async () => null,
  };
  const refunds = await seedEval(db, {
    content: { sandboxName: "support-demo", scorers: [NO_REFUND], trials: 1 },
  });
  await cases.create({
    projectId: PROJECT_ID,
    evalId: refunds.id,
    name: "a",
    labels: [],
    content: content({ input: { message: "refund A200" } }),
    createdBy: "user_1",
  });
  const post = async (body: unknown) => {
    const response = await handleStartEvalRunByMember(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
      PROJECT_ID,
      refunds.id,
      deps,
    );
    return { status: response.status, body: await response.json() };
  };
  return { post, experiments, advanced, datasets };
}

test("New run with the defaults starts a run that records no change", async () => {
  const { post, experiments, advanced } = await setup();
  const started = await post({});
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const run = await experiments.get(PROJECT_ID, started.body.experimentId);
  assert.equal(run?.sandboxVersionId, NEWEST.id);
  assert.deepEqual(run?.changes, {});
  assert.equal(run?.caseVersions.length, 1);
  assert.equal(advanced.length, 1);
});

test("New run with changes for this run only records each change", async () => {
  const { post, experiments } = await setup();
  const started = await post({
    name: "Pinned, large, chosen trace",
    sandboxVersion: OLDER.id,
    matrix: { model: ["small", "large"] },
    addRows: { turnIds: [TURN] },
    scorers: [
      { id: "safe", name: "Answer is safe", ref: { source: "predefined", key: "is_safe" } },
    ],
    trials: 2,
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const run = await experiments.get(PROJECT_ID, started.body.experimentId);
  assert.ok(run);
  assert.equal(run.name, "Pinned, large, chosen trace");
  assert.equal(run.sandboxVersionId, OLDER.id);
  assert.equal(run.variants.length, 2);
  assert.equal(run.caseVersions.length, 2);
  assert.equal(run.trialsPerCase, 2);
  assert.equal(run.changes.sandboxVersionId, OLDER.id);
  assert.equal(run.changes.addedRows, 1);
  assert.equal(run.changes.scorers, true);
  assert.deepEqual(run.changes.matrix, { model: ["small", "large"] });
});

test("rows from the last traces join this run only, and refusals carry their reason", async () => {
  const { post, experiments, datasets } = await setup();
  const started = await post({ addRows: { query: { kind: "last_traces", limit: 5 } } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const run = await experiments.get(PROJECT_ID, started.body.experimentId);
  assert.equal(run?.caseVersions.length, 2);
  const [dataset] = await datasets.list(PROJECT_ID);
  assert.equal(dataset?.rowCount, 1, "the dataset keeps its own rows");
  const tooWide = await post({
    matrix: { model: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"] },
  });
  assert.equal(tooWide.status, 400);
  const rql = await post({
    addRows: { query: { kind: "rql", text: "select trace_id from traces" } },
  });
  assert.equal(rql.status, 400);
  const tooMany = await post({ addRows: { query: { kind: "last_traces", limit: 101 } } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /at most 100 rows/);
  const missing = await post({ datasetId: crypto.randomUUID() });
  assert.equal(missing.status, 404);
});
