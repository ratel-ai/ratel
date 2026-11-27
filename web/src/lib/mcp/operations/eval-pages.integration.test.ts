import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { ActionDeps } from "@/lib/views/evals/actions";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "@/lib/views/evals/adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { currentVersion } from "@/lib/views/evals/domain/eval";
import { startEvalRun } from "@/lib/views/evals/eval-runs";
import {
  content,
  createEvalsDb,
  fakeLibrary,
  fakeTraceSource,
  ORGANIZATION_ID,
  PROJECT_ID,
} from "@/lib/views/evals/tests/support";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { type EvalsOperationDeps, evalsOperations } from "./evals";

/**
 * The MCP side of the "New eval", "Edit" and "New run" dialogs: the same actions as the session
 * routes, with a library reference, a query dataset made with the eval, and rows of one run.
 */

const TURN = "a1111111-1111-4111-8111-111111111111";
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
const auth = {
  kind: "api-key",
  projectId: PROJECT_ID,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: ORGANIZATION_ID, slug: "acme", effectivePlan: "pro" },
} as McpAuthContext;

async function setup(readable = true) {
  const { db } = await createEvalsDb();
  const evals = createDrizzleEvalStore(db);
  const actions: ActionDeps = {
    cases: createDrizzleCaseStore(db),
    evals,
    datasets: createDrizzleDatasetStore(db),
    traces: fakeTraceSource({
      lastTurns: async () => [TURN],
      loadTurn: async () => ({ ask: "refund", messages: [], toolCalls: [], conversation: null }),
    }),
    library: fakeLibrary(),
    experiments: createDrizzleExperimentStore(db),
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [VERSION],
      getVersion: async (_, id) => (id === VERSION.id ? VERSION : null),
      startRun: async () => {
        throw new Error("no trial starts here");
      },
      getRun: async () => null,
    },
    judge: {} as ActionDeps["judge"],
    now: () => new Date(),
    turnRow: async (_, turnId) =>
      turnId === TURN
        ? { name: "x", content: content({ input: "refund A200" }), sourceOutput: null }
        : null,
  };
  const used: Partial<EvalsOperationDeps> = {
    enabled: async () => true,
    getEvalByName: (projectId, name) => evals.getByName(projectId, name),
    getEval: (projectId, id) => evals.get(projectId, id),
    createEval: (input) => evals.create(input),
    actions: () => actions,
    mayReadContent: async () => readable,
    organizationIdOf: async () => ORGANIZATION_ID,
    advance: () => {},
    now: () => new Date(),
    startRuns: async (subject, { eval: one, startedBy, changes }) => {
      const result = await startEvalRun(subject, { eval: one ?? "", startedBy, changes }, actions);
      if (!result.ok) return result;
      return {
        ok: true,
        runs: [{ eval: one ?? "", evalId: result.experiment.evalId ?? "", ok: true, experiment: result.experiment, note: null }],
      };
    },
  };
  const deps = new Proxy(used, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof EvalsOperationDeps]
        : () => {
            throw new Error(`${key} is not used here`);
          },
  }) as EvalsOperationDeps;
  const call = (id: string, params: Record<string, unknown>) =>
    dispatchOperation(id, params, { registry: buildRegistry(evalsOperations(deps)), auth });
  return { call, evals, actions };
}

function ok<Data>(result: Awaited<ReturnType<typeof dispatchOperation>>): DispatchSuccess & { data: Data } {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as DispatchSuccess & { data: Data };
}

test("evals_create takes a runtime, a query dataset, a matrix and library scorers", async () => {
  const { call, evals, actions } = await setup();
  const made = ok<{ evalId: string }>(
    await call("evals_create", {
      name: "Refunds",
      sandboxName: "support-demo",
      sandboxVersionId: VERSION.id,
      datasetQuery: { kind: "last_traces", limit: 10 },
      matrix: { model: ["sonnet", "haiku"] },
      scorers: [
        { name: "Says refund", ref: { source: "predefined", key: "output_contains", settings: { value: "refund" } } },
        { kind: "judge", name: "Polite", gating: false, question: "Is it polite?" },
      ],
    }),
  );
  const found = await evals.get(PROJECT_ID, made.data.evalId);
  assert.ok(found);
  const version = currentVersion(found);
  assert.equal(version.sandboxVersionId, VERSION.id);
  assert.deepEqual(version.matrix, { model: ["sonnet", "haiku"] });
  assert.deepEqual(
    version.scorers.map(({ name, ref, definition }) => [name, ref?.source ?? null, definition.kind]),
    [
      ["Says refund", "predefined", "check"],
      ["Polite", null, "judge"],
    ],
  );
  const dataset = await actions.datasets.get(PROJECT_ID, version.datasetId);
  assert.deepEqual([dataset?.name, dataset?.query], ["Refunds", { kind: "last_traces", limit: 10 }]);

  const edited = ok<{ version: number }>(
    await call("evals_edit", { eval: "Refunds", trials: 1, sandboxVersionId: null }),
  );
  assert.equal(edited.data.version, 2);
  const after = currentVersion((await evals.get(PROJECT_ID, made.data.evalId)) ?? found);
  assert.deepEqual([after.trials, after.sandboxVersionId, after.datasetId], [1, null, version.datasetId]);
  const same = ok<{ version: number }>(await call("evals_edit", { eval: "Refunds", trials: 1 }));
  assert.equal(same.data.version, 2);
});

test("evals_start_run adds rows and scorers for one run, and needs captured text for rows", async () => {
  const { call } = await setup();
  ok(
    await call("evals_create", {
      name: "Refunds",
      sandboxName: "support-demo",
      datasetQuery: { kind: "last_traces", limit: 10 },
      scorers: [{ name: "Safe", ref: { source: "predefined", key: "is_safe", settings: {} } }],
    }),
  );
  const started = ok<{ runs: Array<{ runId: string; cases: number }> }>(
    await call("evals_start_run", {
      eval: "Refunds",
      rows: { kind: "turns", turnIds: [TURN] },
      scorers: [{ name: "Says refund", ref: { source: "predefined", key: "output_contains", settings: { value: "refund" } } }],
    }),
  );
  assert.equal(started.data.runs[0]?.cases, 2);

  const closed = await setup(false);
  ok(
    await closed.call("evals_create", {
      name: "Refunds",
      sandboxName: "support-demo",
      scorers: [{ name: "Safe", ref: { source: "predefined", key: "is_safe", settings: {} } }],
    }),
  );
  const refused = await closed.call("evals_start_run", {
    eval: "Refunds",
    rows: { kind: "turns", turnIds: [TURN] },
  });
  assert.equal(refused.ok, false);
  assert.equal((refused as { error: string }).error, "forbidden");
});
