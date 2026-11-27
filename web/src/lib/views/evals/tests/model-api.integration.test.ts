import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import {
  handleAddRowsByKey,
  handleCreateDatasetByKey,
  handleCreateEvalByKey,
  handleGetDatasetByKey,
  handleGetEvalByKey,
  handleLibraryByKey,
  handleListDatasetsByKey,
  handleListEvalsByKey,
  handleStartRunsByKey,
  type ModelApiDeps,
} from "../model-api";
import { BILLING, SUPPORT, setup } from "./model-support";
import { content, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

/** The key routes of datasets, evals, the library and runs: the flag, the scopes, the refusals. */

const KEY_ID = "99999999-9999-4999-8999-999999999999";

async function api(over: Partial<ModelApiDeps> = {}, sources = {}) {
  const t = await setup(sources);
  const advanced: string[] = [];
  const deps: ModelApiDeps = {
    service: () => ({
      evals: createDrizzleEvalStore(t.db),
      datasets: createDrizzleDatasetStore(t.db),
      cases: createDrizzleCaseStore(t.db),
      experiments: createDrizzleExperimentStore(t.db),
      baselines: createDrizzleBaselineStore(t.db),
      library: { projectScorers: async () => [] },
    }),
    experiments: () => t.deps,
    advance: (experiment) => void advanced.push(experiment.id),
    track: async () => {},
    publicUrl: (path) => `https://ratel.test${path}`,
    readContent: async () => true,
    turnRow: async () => ({
      name: "Case from a turn",
      content: content({ input: { message: "captured words" } }),
      sourceOutput: "recorded",
    }),
    offForAll: () => false,
    authenticate: async () =>
      ({ ok: true, projectId: PROJECT_ID, apiKeyId: KEY_ID }) as Awaited<
        ReturnType<ModelApiDeps["authenticate"]>
      >,
    enabled: async () => true,
    organizationIdOf: async () => ORGANIZATION_ID,
    ...over,
  };
  return { ...t, deps, advanced };
}

const post = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });

/** The real key check over a fake key. */
function authenticate(scope: ApiKeyScope, key: { projectId: string; scopes: string[] }) {
  return () =>
    resolveProjectFromBearer(
      new Request("http://x", { headers: { authorization: "Bearer rtl_key" } }),
      scope,
      {
        isDbConfigured: () => true,
        hashApiKey: (plaintext) => plaintext,
        findActiveApiKeyByHash: async () => ({
          id: KEY_ID,
          keyPrefix: "rtl",
          rateLimitPerMinute: null,
          ...key,
        }),
        touchApiKey: async () => {},
      },
    );
}

test("a key creates a dataset, adds a turn and typed values, lists and reads it with no captured text", async () => {
  const t = await api();
  const made = await handleCreateDatasetByKey(post({ name: "Golden" }), t.deps);
  assert.equal(made.status, 201);
  const { datasetId } = await made.json();
  const added = await handleAddRowsByKey(
    post({
      rows: [
        { turnId: "aaaaaaaa-0000-4000-8000-000000000001" },
        { name: "typed", input: { orderId: "A200" }, expectedOutput: "No refund." },
      ],
    }),
    "Golden",
    t.deps,
  );
  assert.equal(added.status, 201);
  const read = await (await handleGetDatasetByKey(datasetId, t.deps)).json();
  assert.equal(read.definition.kind, "fixed");
  assert.deepEqual(
    read.rows
      .map(({ name, sourceTurnId }: { name: string; sourceTurnId: string | null }) => [
        name,
        sourceTurnId,
      ])
      .sort(),
    [
      ["Case from a turn", "aaaaaaaa-0000-4000-8000-000000000001"],
      ["typed", null],
    ],
  );
  assert.ok(!JSON.stringify(read).includes("captured words"), "no captured input");
  assert.ok(!JSON.stringify(read).includes("A200"), "no typed input");
  const list = await (await handleListDatasetsByKey(t.deps)).json();
  assert.deepEqual(
    list.datasets.map(({ name, rows }: { name: string; rows: number }) => [name, rows]),
    [["Golden", 2]],
  );
  const taken = await handleCreateDatasetByKey(post({ name: "Golden" }), t.deps);
  assert.equal(taken.status, 409);
  const tooBig = await handleCreateDatasetByKey(
    post({ name: "Big", definition: { kind: "last_traces", limit: 501 } }),
    t.deps,
  );
  assert.equal(tooBig.status, 400);
  assert.match((await tooBig.json()).message, /at most 500 rows/);
});

test("a row from a turn needs the project's content, and a query dataset takes no row", async () => {
  const t = await api({ readContent: async () => false });
  await handleCreateDatasetByKey(post({ name: "Golden" }), t.deps);
  const refused = await handleAddRowsByKey(
    post({ rows: [{ turnId: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
    "Golden",
    t.deps,
  );
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /cannot make rows from traces/);
  await handleCreateDatasetByKey(
    post({ name: "Live", definition: { kind: "last_traces", limit: 5 } }),
    t.deps,
  );
  const query = await handleAddRowsByKey(
    post({ rows: [{ name: "x", input: "hi" }] }),
    "Live",
    t.deps,
  );
  assert.equal(query.status, 409);
  assert.equal((await query.json()).error, "not_fixed");
  const none = await handleAddRowsByKey(
    post({ rows: [{ name: "x", input: "hi" }] }),
    "Nope",
    t.deps,
  );
  assert.equal(none.status, 404);
});

test("a key creates an eval of references, lists the evals, reads one, and lists the library", async () => {
  const t = await api();
  const live = await (
    await handleCreateDatasetByKey(
      post({ name: "Live", definition: { kind: "last_traces", limit: 2 } }),
      t.deps,
    )
  ).json();
  const made = await handleCreateEvalByKey(
    post({
      name: "Tone",
      content: {
        datasetId: live.datasetId,
        sandboxName: "support-demo",
        matrix: { tone: ["dry", "warm"] },
        trials: 1,
        scorers: [{ source: "predefined", key: "output_contains", value: "refund" }],
      },
    }),
    t.deps,
  );
  assert.equal(made.status, 201);
  const created = await made.json();
  assert.equal(created.datasetId, live.datasetId);
  const own = await (await handleCreateEvalByKey(post({ name: "Own" }), t.deps)).json();
  assert.ok(own.datasetId, "an eval with no dataset gets a fixed one");
  const overMatrix = await handleCreateEvalByKey(
    post({ name: "Big", content: { matrix: { a: [1, 2, 3, 4, 5], b: [1, 2, 3] } } }),
    t.deps,
  );
  assert.equal(overMatrix.status, 400);
  const foreign = await createDrizzleDatasetStore(t.db).create({
    projectId: OTHER_PROJECT_ID,
    name: "Foreign",
    definition: { kind: "fixed" },
    createdBy: "u",
  });
  assert.ok(typeof foreign === "object");
  const stolen = await handleCreateEvalByKey(
    post({ name: "Stolen", content: { datasetId: foreign.id } }),
    t.deps,
  );
  assert.equal(stolen.status, 404);
  const overview = await (await handleListEvalsByKey(t.deps)).json();
  assert.deepEqual(
    overview.evals.map(({ name, cases, query }: { name: string; cases: number; query: string }) => [
      name,
      cases,
      query,
    ]),
    [
      ["Tone", null, "The newest 2 traces"],
      ["Own", 0, null],
    ],
  );
  const one = await (await handleGetEvalByKey("Tone", t.deps)).json();
  assert.deepEqual(one.version.matrix, { tone: ["dry", "warm"] });
  assert.deepEqual(one.runs, []);
  assert.equal((await handleGetEvalByKey("Nope", t.deps)).status, 404);
  const library = await (await handleLibraryByKey(t.deps)).json();
  assert.ok(
    library.scorers.some(({ refId }: { refId: string }) => refId === "predefined:cost_under"),
  );
});

test("a key starts one run for each eval, with the changes, and a refused eval says why", async () => {
  const t = await api();
  const live = await (
    await handleCreateDatasetByKey(
      post({ name: "Live", definition: { kind: "last_traces", limit: 1 } }),
      t.deps,
    )
  ).json();
  for (const [name, sandboxName] of [
    ["Support", "support-demo"],
    ["Billing", "billing-demo"],
  ]) {
    await handleCreateEvalByKey(
      post({
        name,
        content: {
          datasetId: live.datasetId,
          sandboxName,
          trials: 1,
          scorers: [{ source: "predefined", key: "latency_under", value: 5000 }],
        },
      }),
      t.deps,
    );
  }
  const started = await handleStartRunsByKey(
    post({ sandboxVersion: SUPPORT.id, matrix: { tone: ["dry", "warm"] } }),
    t.deps,
  );
  const body = await started.json();
  assert.equal(started.status, 201, JSON.stringify(body));
  assert.deepEqual(
    body.runs.map(
      ({ eval: name, variants, note }: { eval: string; variants: number; note?: string }) => [
        name,
        variants,
        note === undefined,
      ],
    ),
    [
      ["Support", 2, true],
      ["Billing", 2, false],
    ],
  );
  assert.equal(t.advanced.length, 2);
  const runs = await createDrizzleExperimentStore(t.db).list(PROJECT_ID, 10);
  assert.deepEqual(
    runs.map(({ sandboxVersionId }) => sandboxVersionId).sort(),
    [SUPPORT.id, BILLING.id].sort(),
  );
  const none = await handleCreateEvalByKey(post({ name: "No scorer" }), t.deps);
  assert.equal(none.status, 201);
  const leftOut = await (await handleStartRunsByKey(post({}), t.deps)).json();
  assert.deepEqual(
    leftOut.skipped.map(({ eval: name, error }: { eval: string; error: string }) => [name, error]),
    [["No scorer", "invalid_scorers"]],
  );
  const named = await handleStartRunsByKey(post({ evals: ["No scorer"] }), t.deps);
  assert.equal(named.status, 409);
  assert.match((await named.json()).message, /at least one gating scorer/);
  const unknown = await handleStartRunsByKey(post({ evals: ["Nope"] }), t.deps);
  assert.equal(unknown.status, 404);
  const badMatrix = await handleStartRunsByKey(
    post({ evals: ["Support"], matrix: { temperature: ["0"] } }),
    t.deps,
  );
  assert.equal(badMatrix.status, 400);
  assert.equal((await badMatrix.json()).error, "invalid_matrix");
  const invalid = await handleStartRunsByKey(post({ trials: 0 }), t.deps);
  assert.equal(invalid.status, 400);
});

test("the scopes of the routes, a key of another project, and the flag", async () => {
  const t = await api();
  await handleCreateDatasetByKey(post({ name: "Golden" }), t.deps);
  const read = BEARER_ROUTE_SCOPES["GET /api/v1/evals/datasets"];
  const write = BEARER_ROUTE_SCOPES["POST /api/v1/evals/datasets"];
  const runs = BEARER_ROUTE_SCOPES["POST /api/v1/evals/runs"];
  assert.deepEqual([read, write, runs], ["evals:read", "evals:write", "evals:write"]);
  const as = (scope: ApiKeyScope, scopes: string[], projectId = PROJECT_ID) => ({
    ...t.deps,
    authenticate: authenticate(scope, { projectId, scopes }),
  });
  assert.equal((await handleListDatasetsByKey(as(read, ["evals:write"]))).status, 403);
  assert.equal((await handleListDatasetsByKey(as(read, ["evals:read"]))).status, 200);
  assert.equal(
    (await handleCreateDatasetByKey(post({ name: "X" }), as(write, ["evals:read"]))).status,
    403,
  );
  assert.equal(
    (await handleStartRunsByKey(post({}), as(runs, ["evals:read", "sandboxes:run"]))).status,
    403,
  );
  const other = await (await handleListDatasetsByKey(as(read, ["*"], OTHER_PROJECT_ID))).json();
  assert.deepEqual(other.datasets, []);
  assert.equal(
    (await handleGetDatasetByKey("Golden", as(read, ["*"], OTHER_PROJECT_ID))).status,
    404,
  );
  for (const off of [{ offForAll: () => true }, { enabled: async () => false }]) {
    const deps = { ...t.deps, ...off };
    assert.equal((await handleListDatasetsByKey(deps)).status, 404);
    assert.equal((await handleListEvalsByKey(deps)).status, 404);
    assert.equal((await handleStartRunsByKey(post({}), deps)).status, 404);
    assert.equal((await handleLibraryByKey(deps)).status, 404);
  }
});
