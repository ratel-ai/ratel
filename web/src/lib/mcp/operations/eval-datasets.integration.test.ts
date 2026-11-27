import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { assembleOperations } from "@/lib/mcp/operations";
import { buildRegistry } from "@/lib/mcp/registry";
import { createDrizzleDatasetStore } from "@/lib/views/evals/adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  NO_REFUND,
  PROJECT_ID,
} from "@/lib/views/evals/tests/support";
import type { SandboxRun } from "@/lib/views/sandboxes";
import { type EvalDatasetsDeps, evalDatasetsOperations } from "./eval-datasets";

const TURN = "a1111111-1111-4111-8111-111111111111";
const SANDBOX_RUN = "88888888-8888-4888-8888-888888888888";
const IDS = [
  "evals_list_datasets",
  "evals_get_dataset",
  "evals_create_dataset",
  "evals_add_dataset_row",
  "evals_remove_dataset_row",
  "evals_preview_dataset",
  "evals_list_scorers",
  "evals_get_history",
];
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT_ID,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
} as McpAuthContext;

async function setup(over: Partial<EvalDatasetsDeps> = {}) {
  const { db } = await createEvalsDb();
  const experiments = createDrizzleExperimentStore(db);
  const deps: EvalDatasetsDeps = {
    enabled: async () => true,
    datasets: () => createDrizzleDatasetStore(db),
    evals: () => createDrizzleEvalStore(db),
    library: () => fakeLibrary(),
    runs: async (projectId, limit) => {
      const list = await experiments.list(projectId, limit);
      return Promise.all(
        list.map(async (experiment) => ({
          experiment,
          trials: await experiments.trials(experiment.id),
        })),
      );
    },
    run: async (projectId, id) => {
      const experiment = await experiments.get(projectId, id);
      return experiment ? { experiment, trials: await experiments.trials(id) } : null;
    },
    baselineOf: async () => null,
    turnRow: async (_, turnId) =>
      turnId === TURN
        ? { content: content({ input: { message: "captured ask" } }), sourceOutput: "ok" }
        : null,
    getSandboxRun: async (_, id) =>
      id === SANDBOX_RUN
        ? ({
            id,
            request: { input: { message: "playground" } },
            result: { output: "done" },
          } as unknown as SandboxRun)
        : null,
    mayReadContent: async () => true,
    traces: () => fakeTraceSource(),
    now: () => new Date(),
    ...over,
  };
  const call = (id: string, params: Record<string, unknown>, key: McpAuthContext = auth) =>
    dispatchOperation(id, params, {
      registry: buildRegistry(evalDatasetsOperations(deps)),
      auth: key,
    });
  return { db, deps, call };
}

function ok<Data>(
  result: Awaited<ReturnType<typeof dispatchOperation>>,
): DispatchSuccess & { data: Data } {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as DispatchSuccess & { data: Data };
}

function failure(result: Awaited<ReturnType<typeof dispatchOperation>>) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: false }>;
}

test("the dataset tools are listed only with the evals flag, and only the create, add and remove tools mutate", () => {
  const on = assembleOperations({ evals: true });
  const off = assembleOperations({ evals: false }).map(({ id }) => id);
  for (const id of IDS) {
    assert.ok(
      on.some((operation) => operation.id === id),
      `${id} is listed`,
    );
    assert.ok(!off.includes(id), `${id} is not listed with the flag off`);
  }
  assert.deepEqual(
    on.filter(({ id, mutates }) => IDS.includes(id) && mutates).map(({ id }) => id),
    ["evals_create_dataset", "evals_add_dataset_row", "evals_remove_dataset_row"],
  );
  for (const operation of on.filter(({ id }) => IDS.includes(id))) {
    assert.ok(operation.description.length <= 400, `${operation.id} has a short description`);
    assert.match(operation.description, /returns/, `${operation.id} says what it returns`);
  }
});

test("an agent creates a fixed dataset, adds a trace turn, a Playground run and typed values, and reads it", async () => {
  const { call } = await setup();
  const made = ok<{ datasetId: string; kind: string }>(
    await call("evals_create_dataset", { name: "Refund asks" }),
  );
  assert.equal(made.data.kind, "fixed");
  ok(await call("evals_add_dataset_row", { dataset: "Refund asks", turnId: TURN }));
  ok(await call("evals_add_dataset_row", { dataset: "Refund asks", sandboxRunId: SANDBOX_RUN }));
  ok(
    await call("evals_add_dataset_row", {
      dataset: made.data.datasetId,
      name: "typed",
      values: { order: "A1", amount: 3 },
      expectedOutput: "No refund.",
    }),
  );
  const read = ok<{
    rows: Array<{ name: string; kind: string; turnId: string | null; input: string | null }>;
  }>(await call("evals_get_dataset", { dataset: "Refund asks" }));
  const byName = new Map(read.data.rows.map((row) => [row.name, row]));
  assert.deepEqual(byName.get(`Turn ${TURN.slice(0, 8)}`)?.turnId, TURN);
  assert.equal(byName.get(`Turn ${TURN.slice(0, 8)}`)?.kind, "trace");
  assert.match(byName.get(`Playground run ${SANDBOX_RUN.slice(0, 8)}`)?.input ?? "", /playground/);
  assert.equal(byName.get("typed")?.kind, "values");
  const listed = ok<{ datasets: Array<{ name: string; rows: number }> }>(
    await call("evals_list_datasets", {}),
  );
  assert.deepEqual(
    listed.data.datasets.map(({ name, rows }) => [name, rows]),
    [["Refund asks", 3]],
  );
});

test("each query kind is created with its settings, and a query dataset takes no row", async () => {
  const { call } = await setup();
  const created = [
    { name: "last", kind: "last_traces", limit: 20 },
    { name: "task", kind: "task_traces", taskId: "wf-refunds" },
    { name: "rql", kind: "rql", text: "select trace_id from traces where has_error" },
    { name: "auto", kind: "auto" },
  ];
  for (const params of created) ok(await call("evals_create_dataset", params));
  const refused = failure(
    await call("evals_add_dataset_row", { dataset: "last", name: "x", values: { a: 1 } }),
  );
  assert.deepEqual([refused.error, refused.reason], ["conflict", "dataset_not_fixed"]);
  const noText = failure(await call("evals_create_dataset", { name: "bad", kind: "rql" }));
  assert.equal(noText.error, "invalid_params");
  const tooMany = failure(
    await call("evals_create_dataset", { name: "big", kind: "last_traces", limit: 501 }),
  );
  assert.equal(tooMany.error, "invalid_params");
  const listed = ok<{ datasets: Array<{ name: string; query: string | null }> }>(
    await call("evals_list_datasets", {}),
  );
  assert.ok(listed.data.datasets.some(({ query }) => query === "The last 20 traces"));
});

test("a row from a turn needs content access, and the refusal says so", async () => {
  const { call } = await setup({ mayReadContent: async () => false });
  ok(await call("evals_create_dataset", { name: "Asks" }));
  const refused = failure(await call("evals_add_dataset_row", { dataset: "Asks", turnId: TURN }));
  assert.deepEqual([refused.error, refused.reason], ["forbidden", "no_content_access"]);
  ok(await call("evals_add_dataset_row", { dataset: "Asks", name: "typed", values: { a: 1 } }));
  const read = ok<{ rows: Array<{ input: unknown }>; contentWithheld?: boolean }>(
    await call("evals_get_dataset", { dataset: "Asks" }),
  );
  assert.equal(read.data.contentWithheld, true);
  assert.equal(read.data.rows[0]?.input, null);
});

test("the scorer library, the runs of an eval, and the refusals of the flag and the scope", async () => {
  const { db, call } = await setup();
  await createDrizzleEvalStore(db).create({
    projectId: PROJECT_ID,
    name: "Refunds",
    taskId: null,
    content: {
      datasetId: null,
      sandboxVersionId: null,
      matrix: {},
      sandboxName: null,
      params: {},
      trials: 3,
      scorers: [NO_REFUND],
    },
    createdBy: "u",
  });
  const library = ok<{ scorers: Array<{ source: string; name: string }> }>(
    await call("evals_list_scorers", {}),
  );
  assert.ok(
    library.data.scorers.some(
      ({ source, name }) => source === "predefined" && name === "Tool was called",
    ),
  );
  assert.ok(
    library.data.scorers.some(({ source, name }) => source === "eval" && name === NO_REFUND.name),
  );
  const history = ok<{ runs: unknown[]; rule: string }>(
    await call("evals_get_history", { eval: "Refunds" }),
  );
  assert.deepEqual(history.data.runs, []);
  assert.match(history.data.rule, /mean/);
  assert.equal(failure(await call("evals_get_history", { eval: "Nope" })).error, "not_found");
  const readOnly = { ...auth, scopes: ["mcp:read", "mcp:write", "evals:read"] } as McpAuthContext;
  const refused = failure(await call("evals_create_dataset", { name: "x" }, readOnly));
  assert.equal(refused.error, "forbidden");
  assert.match(refused.message, /evals:write/);
  const { call: off } = await setup({ enabled: async () => false });
  const flag = failure(await off("evals_list_datasets", {}));
  assert.deepEqual([flag.error, flag.reason], ["forbidden", "evals_off"]);
});

test("a row is removed from a fixed dataset of the project, and a query has no row", async () => {
  const { call } = await setup();
  await call("evals_create_dataset", { name: "Typed" });
  const added = ok(
    await call("evals_add_dataset_row", { dataset: "Typed", name: "One", values: { order: "A1" } }),
  ).data as { rowId: string };
  const removed = ok(await call("evals_remove_dataset_row", { dataset: "Typed", rowId: added.rowId }));
  assert.deepEqual((removed.data as { rowId: string }).rowId, added.rowId);
  const read = ok(await call("evals_get_dataset", { dataset: "Typed" })).data as { rows: unknown[] };
  assert.equal(read.rows.length, 0);
  const again = failure(await call("evals_remove_dataset_row", { dataset: "Typed", rowId: added.rowId }));
  assert.equal(again.error, "not_found");
  await call("evals_create_dataset", { name: "Last", kind: "last_traces", limit: 5 });
  const query = failure(await call("evals_remove_dataset_row", { dataset: "Last", rowId: added.rowId }));
  assert.equal(query.error, "conflict");
});

test("a preview reads a query now, with the content rule of the key", async () => {
  const turns = new Map([[TURN, { ask: "refund A200", messages: [], toolCalls: [], conversation: null }]]);
  const { call } = await setup({
    traces: () =>
      fakeTraceSource({
        lastTurns: async () => [TURN],
        loadTurn: async (_, id) => turns.get(id) ?? null,
      }),
  });
  const preview = ok(await call("evals_preview_dataset", { kind: "last_traces", limit: 5 })).data as {
    ok: boolean;
    found: number;
  };
  assert.equal(preview.ok, true);
  assert.equal(preview.found, 1);
  const bad = failure(await call("evals_preview_dataset", { kind: "rql" }));
  assert.equal(bad.error, "invalid_params");
  const { call: closedCall } = await setup({ mayReadContent: async () => false });
  const closed = ok(await closedCall("evals_preview_dataset", { kind: "last_traces" })).data as {
    reason: string;
  };
  assert.equal(closed.reason, "no_content_access");
});
