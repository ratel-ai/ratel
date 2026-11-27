import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { SandboxRun, SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import type { ExperimentDeps } from "../experiments";
import { handleGetByKey } from "../experiments-api";
import {
  handleAddRowsByKey,
  handleCreateDatasetByKey,
  handleCreateEvalByKey,
  handleDatasetByKey,
  handleDatasetsByKey,
  handleEvalByKey,
  handleEvalsOverviewByKey,
  handleStartEachByKey,
  handleStartEvalRunByKey,
  type RunsApiDeps,
} from "../runs-api";
import {
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  NO_REFUND,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
} from "./support";

const SUPPORT: SandboxVersionSummary = {
  id: "66666666-6666-4666-8666-666666666661",
  projectId: PROJECT_ID,
  sandboxId: "77777777-7777-4777-8777-777777777771",
  name: "support-demo",
  git: { commit: "a".repeat(40), dirty: false },
  status: "ready",
  createdAt: new Date(),
  tools: [],
  params: [
    { name: "model", type: "string", default: null, description: null, options: [] },
    { name: "depth", type: "number", default: 1, description: null, options: [] },
  ],
};
const BILLING: SandboxVersionSummary = {
  ...SUPPORT,
  id: "66666666-6666-4666-8666-666666666662",
  sandboxId: "77777777-7777-4777-8777-777777777772",
  name: "billing",
};
const SANDBOX_RUN = "88888888-8888-4888-8888-888888888888";

async function setup() {
  const { db, client } = await createEvalsDb();
  const evals = createDrizzleEvalStore(db);
  const datasets = createDrizzleDatasetStore(db);
  const baselines = createDrizzleBaselineStore(db);
  const experiments = createDrizzleExperimentStore(db);
  const advanced: string[] = [];
  const engine: ExperimentDeps = {
    cases: createDrizzleCaseStore(db),
    evals,
    datasets,
    traces: fakeTraceSource(),
    library: fakeLibrary(),
    experiments,
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [SUPPORT, BILLING],
      getVersion: async (_, id) => [SUPPORT, BILLING].find((one) => one.id === id) ?? null,
      startRun: async () => {
        throw new Error("no trial starts here");
      },
      getRun: async (projectId, id) =>
        projectId === PROJECT_ID && id === SANDBOX_RUN
          ? ({
              id,
              request: { input: { message: "from the playground" } },
            } as unknown as SandboxRun)
          : null,
    },
    judge: {} as ExperimentDeps["judge"],
    now: () => new Date(),
  };
  const deps = (over: Partial<RunsApiDeps> = {}): RunsApiDeps => ({
    experiments: () => engine,
    advance: ({ id }) => void advanced.push(id),
    track: async () => {},
    publicUrl: (path) => `https://ratel.test${path}`,
    baseline: async () => null,
    offForAll: () => false,
    authenticate: async () =>
      ({ ok: true, projectId: PROJECT_ID, apiKeyId: "k1" }) as Awaited<
        ReturnType<RunsApiDeps["authenticate"]>
      >,
    enabled: async () => true,
    organizationIdOf: async () => ORGANIZATION_ID,
    catalog: () => ({ evals, datasets, baselines }),
    ...over,
  });
  return { db, client, deps, advanced, experiments };
}

const post = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });

async function json(response: Promise<Response>) {
  const answer = await response;
  return { status: answer.status, body: await answer.json() };
}

test("a key creates a dataset with value rows and a sandbox run row, an eval on it, and reads both", async () => {
  const { deps } = await setup();
  const dataset = await json(
    handleCreateDatasetByKey(
      post({
        name: "Refund asks",
        rows: [
          { kind: "values", name: "typed", values: { order: "A1" }, expectedOutput: "No." },
          { kind: "sandbox_run", name: "from a run", sandboxRunId: SANDBOX_RUN },
        ],
      }),
      deps(),
    ),
  );
  assert.equal(dataset.status, 201);
  assert.equal(dataset.body.rows, 2);
  const made = await json(
    handleCreateEvalByKey(
      post({
        name: "Refunds",
        dataset: "Refund asks",
        sandboxName: "support-demo",
        matrix: { model: ["small", "large"] },
        scorers: [
          NO_REFUND,
          {
            id: "tool",
            name: "Tool was called",
            gating: false,
            ref: { source: "predefined", key: "expected_tool", settings: { tool: "lookup" } },
          },
        ],
      }),
      deps(),
    ),
  );
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.eval.datasetId, dataset.body.dataset.datasetId);
  assert.deepEqual(
    made.body.eval.scorers.map(({ source }: { source: string }) => source),
    ["eval", "predefined"],
  );
  const read = await json(handleDatasetByKey("Refund asks", deps()));
  assert.deepEqual(
    read.body.rows.map(({ name, kind }: { name: string; kind: string }) => [name, kind]).sort(),
    [
      ["from a run", "values"],
      ["typed", "values"],
    ],
  );
  assert.ok(!JSON.stringify(read.body).includes("from the playground"));
  const list = await json(handleDatasetsByKey(deps()));
  assert.deepEqual(list.body.datasets[0].evals, [
    { evalId: made.body.eval.evalId, name: "Refunds" },
  ]);
  assert.equal(list.body.datasets[0].rows, 2);
  const more = await json(
    handleAddRowsByKey(
      post({ rows: [{ kind: "values", name: "third", values: { order: "C3" } }] }),
      dataset.body.dataset.datasetId,
      deps(),
    ),
  );
  assert.equal(more.status, 201);
});

test("a key starts a run of one eval with a matrix, and reads it with its eval, variants and run score", async () => {
  const { deps, advanced } = await setup();
  await json(
    handleCreateDatasetByKey(
      post({ name: "Asks", rows: [{ kind: "values", name: "a", values: { x: 1 } }] }),
      deps(),
    ),
  );
  await json(
    handleCreateEvalByKey(post({ name: "Refunds", dataset: "Asks", scorers: [NO_REFUND] }), deps()),
  );
  const started = await json(
    handleStartEvalRunByKey(
      post({ matrix: { model: ["small", "large"] }, params: { depth: 2 }, trials: 1 }),
      "Refunds",
      deps(),
    ),
  );
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.eval, "Refunds");
  assert.deepEqual(advanced, [started.body.experimentId]);
  const read = await json(handleGetByKey(started.body.experimentId, deps()));
  assert.equal(read.body.evalId, started.body.evalId);
  assert.deepEqual(
    read.body.variants.map(({ params }: { params: object }) => params),
    [{ model: "small" }, { model: "large" }],
  );
  assert.equal(read.body.run.variants.length, 2);
  assert.match(read.body.run.rule, /mean of the scores of its variants/);
  const one = await json(handleEvalByKey("Refunds", deps()));
  assert.equal(one.body.runs[0].experimentId, started.body.experimentId);
  assert.deepEqual(one.body.runs[0].params, { depth: 2 });
  const overview = await json(handleEvalsOverviewByKey(deps()));
  assert.deepEqual(
    overview.body.evals.map(({ name, cases, scorers }: Record<string, unknown>) => [
      name,
      cases,
      scorers,
    ]),
    [["Refunds", 1, 1]],
  );
});

test("a start of each eval gives one part for each eval, and a version of another sandbox does not apply", async () => {
  const { deps } = await setup();
  await json(
    handleCreateDatasetByKey(
      post({ name: "Asks", rows: [{ kind: "values", name: "a", values: { x: 1 } }] }),
      deps(),
    ),
  );
  for (const [name, sandboxName] of [
    ["Refunds", "support-demo"],
    ["Invoices", "billing"],
  ]) {
    await json(
      handleCreateEvalByKey(
        post({ name, dataset: "Asks", sandboxName, scorers: [NO_REFUND] }),
        deps(),
      ),
    );
  }
  await json(handleCreateEvalByKey(post({ name: "Empty", scorers: [NO_REFUND] }), deps()));
  const each = await json(handleStartEachByKey(post({ sandboxVersion: SUPPORT.id }), deps()));
  assert.equal(each.status, 201);
  const byName = new Map(each.body.runs.map((part: { eval: string }) => [part.eval, part]));
  assert.ok((byName.get("Refunds") as { experimentId?: string }).experimentId);
  assert.match((byName.get("Invoices") as { note: string }).note, /runs on billing/);
  assert.equal((byName.get("Empty") as { error: string }).error, "no_cases");
  const unknown = await json(handleStartEachByKey(post({ evals: ["Nope"] }), deps()));
  assert.equal(unknown.status, 404);
});

test("refusals: a wrong body, an unknown eval or dataset, a matrix over 12, a query dataset with rows", async () => {
  const { deps } = await setup();
  assert.equal((await handleStartEvalRunByKey(post({ trials: 0 }), "Refunds", deps())).status, 400);
  const unknown = await json(handleStartEvalRunByKey(post({}), "Nope", deps()));
  assert.deepEqual([unknown.status, unknown.body.error], [404, "not_found"]);
  assert.equal((await handleEvalByKey("Nope", deps())).status, 404);
  assert.equal((await handleDatasetByKey("Nope", deps())).status, 404);
  const big = await handleCreateEvalByKey(
    post({ name: "Big", matrix: { a: [1, 2, 3, 4], b: [1, 2, 3, 4] } }),
    deps(),
  );
  assert.equal(big.status, 400);
  const query = await json(
    handleCreateDatasetByKey(
      post({
        name: "Q",
        query: { kind: "last_traces" },
        rows: [{ kind: "values", name: "a", values: { x: 1 } }],
      }),
      deps(),
    ),
  );
  assert.equal(query.status, 400);
  await json(
    handleCreateDatasetByKey(
      post({ name: "Last", query: { kind: "last_traces", limit: 10 } }),
      deps(),
    ),
  );
  const added = await json(
    handleAddRowsByKey(
      post({ rows: [{ kind: "values", name: "a", values: { x: 1 } }] }),
      "Last",
      deps(),
    ),
  );
  assert.deepEqual([added.status, added.body.error], [409, "dataset_not_fixed"]);
  assert.equal((await handleCreateDatasetByKey(post({ name: "Last" }), deps())).status, 409);
});

test("each route needs its scope, answers 404 with the flag off, and shows no data of another project", async () => {
  const { deps } = await setup();
  await json(handleCreateEvalByKey(post({ name: "Refunds", scorers: [NO_REFUND] }), deps()));
  const as = (route: keyof typeof BEARER_ROUTE_SCOPES, scopes: string[], projectId = PROJECT_ID) =>
    deps({ authenticate: authenticate(BEARER_ROUTE_SCOPES[route], { projectId, scopes }) });
  const calls: Array<[keyof typeof BEARER_ROUTE_SCOPES, (d: RunsApiDeps) => Promise<Response>]> = [
    ["GET /api/v1/evals", (d) => handleEvalsOverviewByKey(d)],
    ["POST /api/v1/evals", (d) => handleCreateEvalByKey(post({ name: "Other" }), d)],
    ["GET /api/v1/evals/[eval]", (d) => handleEvalByKey("Refunds", d)],
    ["POST /api/v1/evals/[eval]/runs", (d) => handleStartEvalRunByKey(post({}), "Refunds", d)],
    ["POST /api/v1/evals/runs", (d) => handleStartEachByKey(post({}), d)],
    ["GET /api/v1/evals/datasets", (d) => handleDatasetsByKey(d)],
    ["POST /api/v1/evals/datasets", (d) => handleCreateDatasetByKey(post({ name: "D" }), d)],
    ["GET /api/v1/evals/datasets/[dataset]", (d) => handleDatasetByKey("Refunds", d)],
    [
      "POST /api/v1/evals/datasets/[dataset]/rows",
      (d) => handleAddRowsByKey(post({ rows: [] }), "Refunds", d),
    ],
  ];
  for (const [route, call] of calls) {
    const scope = BEARER_ROUTE_SCOPES[route];
    const wrong = scope === "evals:read" ? "evals:write" : "evals:read";
    assert.equal((await call(as(route, [wrong]))).status, 403, route);
    assert.notEqual((await call(as(route, [scope]))).status, 403, route);
    for (const off of [{ offForAll: () => true }, { enabled: async () => false }]) {
      assert.equal((await call(deps(off))).status, 404, route);
    }
  }
  const other = await json(
    handleEvalsOverviewByKey(as("GET /api/v1/evals", ["*"], OTHER_PROJECT_ID)),
  );
  assert.deepEqual(other.body.evals, []);
  assert.equal(
    (await handleEvalByKey("Refunds", as("GET /api/v1/evals/[eval]", ["*"], OTHER_PROJECT_ID)))
      .status,
    404,
  );
});

function authenticate(scope: ApiKeyScope, key: { projectId: string; scopes: string[] }) {
  return () =>
    resolveProjectFromBearer(
      new Request("http://x", { headers: { authorization: "Bearer rtl_key" } }),
      scope,
      {
        isDbConfigured: () => true,
        hashApiKey: (plaintext) => plaintext,
        findActiveApiKeyByHash: async () => ({
          id: "99999999-9999-4999-8999-999999999999",
          keyPrefix: "rtl",
          rateLimitPerMinute: null,
          ...key,
        }),
        touchApiKey: async () => {},
      },
    );
}
