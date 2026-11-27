import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { currentVersion } from "../domain/eval";
import { type EvalDialogDeps, handleCreateEvalFromDialog } from "../eval-dialog-api";
import { createEvalsDb, fakeLibrary, ORGANIZATION_ID, PROJECT_ID } from "./support";

const READY = "66666666-6666-4666-8666-666666666666";
const FAILED = "67666666-6666-4666-8666-666666666666";
const OTHER = "68666666-6666-4666-8666-666666666666";

function version(id: string, name: string, status: SandboxVersionSummary["status"]) {
  return {
    id,
    projectId: PROJECT_ID,
    sandboxId: `${name}-id`,
    name,
    git: { commit: "c".repeat(40), dirty: false },
    status,
    createdAt: new Date(),
    tools: [],
    params: [
      {
        name: "model",
        type: "enum",
        default: "small",
        description: null,
        options: ["small", "large"],
      },
      { name: "temperature", type: "number", default: 0, description: null, options: [] },
    ],
  } satisfies SandboxVersionSummary;
}

async function setup() {
  const { db } = await createEvalsDb();
  const evals = createDrizzleEvalStore(db);
  const datasets = createDrizzleDatasetStore(db);
  const deps = (over: Partial<EvalDialogDeps> = {}): EvalDialogDeps => ({
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT_ID
        ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role: "member" }
        : null,
    enabled: async () => true,
    isRestricted: async () => false,
    evals: () => evals,
    datasets: () => datasets,
    library: () => fakeLibrary(),
    versions: async () => [
      version(READY, "support-demo", "ready"),
      version(FAILED, "support-demo", "failed"),
      version(OTHER, "other-agent", "ready"),
    ],
    ...over,
  });
  const post = async (body: unknown, d = deps()) => {
    const response = await handleCreateEvalFromDialog(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
      PROJECT_ID,
      d,
    );
    return { status: response.status, body: await response.json() };
  };
  const fixed = await datasets.create({
    projectId: PROJECT_ID,
    name: "Order asks",
    description: null,
    query: { kind: "fixed" },
    createdBy: "u",
  });
  if (fixed === "name_taken") throw new Error("taken");
  return { evals, datasets, post, deps, fixedId: fixed.id };
}

const SCORERS = [
  { id: "safe", name: "Answer is safe", ref: { source: "predefined", key: "is_safe" } },
  {
    id: "tool",
    name: "Calls track_order",
    gating: false,
    ref: { source: "predefined", key: "expected_tool", settings: { tool: "track_order" } },
  },
];

test("an eval is made on an existing dataset, the newest ready version, library scorers", async () => {
  const { evals, post, fixedId } = await setup();
  const made = await post({
    name: "Orders",
    taskId: "wf-orders",
    runtime: { sandboxName: "support-demo", sandboxVersionId: null },
    dataset: { datasetId: fixedId },
    trials: 2,
    scorers: SCORERS,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const stored = await evals.get(PROJECT_ID, made.body.evalId);
  assert.ok(stored);
  const content = currentVersion(stored);
  assert.equal(stored.taskId, "wf-orders");
  assert.equal(content.datasetId, fixedId);
  assert.equal(content.sandboxName, "support-demo");
  assert.equal(content.sandboxVersionId, null);
  assert.equal(content.trials, 2);
  assert.deepEqual(
    content.scorers.map(({ id, gating, ref, definition }) => [
      id,
      gating,
      ref?.source,
      definition.kind,
    ]),
    [
      ["safe", true, "predefined", "judge"],
      ["tool", false, "predefined", "check"],
    ],
  );
});

test("a pinned version, params and a matrix; a query dataset made in the dialog", async () => {
  const { evals, datasets, post } = await setup();
  const made = await post({
    name: "Orders matrix",
    runtime: { sandboxName: "support-demo", sandboxVersionId: READY },
    dataset: { query: { kind: "last_traces", limit: 20 } },
    params: { temperature: 0.2 },
    matrix: { model: ["small", "large"] },
    scorers: SCORERS.slice(0, 1),
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const stored = await evals.get(PROJECT_ID, made.body.evalId);
  assert.ok(stored);
  const content = currentVersion(stored);
  assert.equal(content.sandboxVersionId, READY);
  assert.deepEqual(content.params, { temperature: 0.2 });
  assert.deepEqual(content.matrix, { model: ["small", "large"] });
  const dataset = await datasets.get(PROJECT_ID, content.datasetId);
  assert.equal(dataset?.name, "Orders matrix traces");
  assert.deepEqual(dataset?.query, { kind: "last_traces", limit: 20 });
  for (const query of [
    { kind: "task_traces", taskId: "wf-orders" },
    { kind: "rql", text: "select trace_id from traces" },
    { kind: "auto" },
  ]) {
    const other = await post({
      name: `Q ${query.kind}`,
      runtime: { sandboxName: "support-demo", sandboxVersionId: null },
      dataset: { query, name: `Data ${query.kind}` },
      scorers: SCORERS.slice(0, 1),
    });
    assert.equal(other.status, 201, query.kind);
  }
});

test("a matrix over 12 combinations is refused with the reason", async () => {
  const { post, fixedId } = await setup();
  const refused = await post({
    name: "Too wide",
    runtime: { sandboxName: "support-demo", sandboxVersionId: null },
    dataset: { datasetId: fixedId },
    matrix: { model: ["small", "large"], temperature: [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2] },
    scorers: SCORERS.slice(0, 1),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /at most 12 combinations/);
});

test("the runtime must be a ready version of the sandbox; Production agent is not a runtime yet", async () => {
  const { post, fixedId } = await setup();
  const base = { name: "R", dataset: { datasetId: fixedId }, scorers: SCORERS.slice(0, 1) };
  const cases: Array<[unknown, number, string]> = [
    [{ sandboxName: "nobody", sandboxVersionId: null }, 404, "sandbox_not_found"],
    [{ sandboxName: "support-demo", sandboxVersionId: FAILED }, 409, "version_not_ready"],
    [{ sandboxName: "support-demo", sandboxVersionId: OTHER }, 409, "wrong_sandbox"],
    [{ kind: "production" }, 400, "invalid"],
  ];
  for (const [runtime, status, error] of cases) {
    const answer = await post({ ...base, runtime });
    assert.equal(answer.status, status, JSON.stringify(runtime));
    assert.equal(answer.body.error, error);
  }
});

test("names, datasets and scorers are checked, and nothing half-made stays", async () => {
  const { datasets, post, fixedId } = await setup();
  const ok = {
    runtime: { sandboxName: "support-demo", sandboxVersionId: null },
    scorers: SCORERS.slice(0, 1),
  };
  assert.equal((await post({ ...ok, name: "Taken", dataset: { datasetId: fixedId } })).status, 201);
  const taken = await post({ ...ok, name: "Taken", dataset: { query: { kind: "auto" } } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "name_taken");
  assert.equal((await datasets.list(PROJECT_ID)).length, 1, "no dataset for a refused eval");
  const missing = await post({ ...ok, name: "M", dataset: { datasetId: crypto.randomUUID() } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "dataset_not_found");
  const noScorer = await post({ ...ok, name: "N", dataset: { datasetId: fixedId }, scorers: [] });
  assert.equal(noScorer.status, 400);
  const badSetting = await post({
    ...ok,
    name: "B",
    dataset: { datasetId: fixedId },
    scorers: [{ id: "t", name: "Tool", ref: { source: "predefined", key: "expected_tool" } }],
  });
  assert.equal(badSetting.status, 400);
  assert.equal(badSetting.body.error, "invalid_scorers");
});
