import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Dataset } from "@/lib/views/fine-tuning/domain/dataset";
import { emptyCounts } from "@/lib/views/fine-tuning/domain/redaction";
import { buildSettings, emptyDrops } from "@/lib/views/fine-tuning/domain/rows";
import type { UseCase } from "@/lib/views/fine-tuning/domain/use-case";
import { type FineTuningOperationDeps, fineTuningOperations } from "./fine-tuning";

/** The Fine-tuning page over MCP (RC-1124), behind `FF_FINE_TUNING`: off, every tool is forbidden. */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USE_CASE_ID = "55555555-5555-4555-8555-555555555555";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const USE_CASE: UseCase = {
  id: USE_CASE_ID,
  projectId: PROJECT,
  name: "Triage",
  selector: { taskIds: ["triage"], intentIds: [] },
  createdBy: `project:${PROJECT}`,
  createdAt: new Date("2026-11-20T00:00:00.000Z"),
  archivedAt: null,
};

const STATS = {
  turns: 12,
  calls: 30,
  firstEndedAt: "2026-11-01T00:00:00.000Z",
  lastEndedAt: "2026-11-19T00:00:00.000Z",
  currentModel: "claude-haiku",
  costPerRunUsd: 0.004,
  pricedRuns: 12,
  unpricedCalls: 0,
  sampled: false,
};

const DATASET_ID = "77777777-7777-4777-8777-777777777777";
const DATASET: Dataset = {
  id: DATASET_ID,
  projectId: PROJECT,
  useCaseId: USE_CASE_ID,
  version: 1,
  status: "ready",
  settings: {
    ...buildSettings(USE_CASE.selector),
    window: { since: "2026-10-21T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" },
  },
  contentHash: "abc",
  counts: {
    turns: 12,
    calls: 14,
    cursor: { capturedAt: "2026-11-19T00:00:00.000Z", eventId: "e-1" },
    train: 9,
    eval: 2,
    dropped: { ...emptyDrops(), duplicate_near: 1 },
  },
  redactionReport: { ...emptyCounts(), email: 3 },
  createdBy: `project:${PROJECT}`,
  createdAt: new Date("2026-11-20T00:00:00.000Z"),
  failedReason: null,
};

function harness(overrides: Partial<FineTuningOperationDeps> = {}) {
  const calls = { created: [] as unknown[], tracked: 0, reads: 0, builds: [] as unknown[] };
  const deps: FineTuningOperationDeps = {
    fineTuningEnabled: async () => true,
    listUseCases: async () => {
      calls.reads++;
      return [USE_CASE];
    },
    getUseCase: async (_projectId, id) => {
      calls.reads++;
      return id === USE_CASE_ID ? USE_CASE : null;
    },
    createUseCase: async (projectId, input, actor) => {
      calls.created.push({ projectId, input, actor });
      return input.name === "Taken"
        ? { ok: false, reason: "name_taken" }
        : { ok: true, useCase: { ...USE_CASE, ...input } };
    },
    useCaseStats: async () => STATS,
    track: async () => {
      calls.tracked++;
    },
    buildDataset: async (projectId, useCaseId, input, actor) => {
      calls.builds.push({ projectId, useCaseId, input, actor });
      if (useCaseId !== USE_CASE_ID)
        return { ok: false, reason: "use_case_not_found", message: "none" };
      return {
        ok: true,
        dataset: {
          ...DATASET,
          status: "building",
          contentHash: null,
          counts: null,
          redactionReport: null,
        },
      };
    },
    getDataset: async (_projectId, id) => {
      calls.reads++;
      return id === DATASET_ID ? DATASET : null;
    },
    ...overrides,
  };
  const run = (operationId: string, params: unknown) =>
    dispatchOperation(operationId, params, {
      registry: buildRegistry(fineTuningOperations(deps)),
      auth,
    });
  return { run, calls };
}

test("list_use_cases returns the use cases; get_use_case adds turns, calls, dates, model and cost per run", async () => {
  const { run } = harness();
  const list = await run("list_use_cases", {});
  assert.ok(list.ok);
  assert.deepEqual((list.data as { useCases: unknown[] }).useCases, [
    {
      id: USE_CASE_ID,
      name: "Triage",
      selector: { taskIds: ["triage"], intentIds: [] },
      createdBy: `project:${PROJECT}`,
      createdAt: "2026-11-20T00:00:00.000Z",
    },
  ]);
  const one = await run("get_use_case", { useCaseId: USE_CASE_ID });
  assert.ok(one.ok && (one.data as { name: string }).name === "Triage");
  assert.deepEqual((one.data as { stats: unknown }).stats, STATS);
  const missing = await run("get_use_case", { useCaseId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(missing.ok === false && missing.error, "not_found");
});

test("create_use_case creates as the key's project and emits one event; an empty selector or a taken name is refused", async () => {
  const { run, calls } = harness();
  const created = await run("create_use_case", {
    name: "Refunds",
    selector: { taskIds: ["refund"] },
  });
  assert.ok(created.ok, JSON.stringify(created));
  assert.deepEqual(calls.created, [
    {
      projectId: PROJECT,
      input: { name: "Refunds", selector: { taskIds: ["refund"], intentIds: [] } },
      actor: `project:${PROJECT}`,
    },
  ]);
  assert.equal(calls.tracked, 1);

  const empty = await run("create_use_case", { name: "Empty", selector: {} });
  assert.equal(empty.ok === false && empty.error, "invalid_params");
  const unknown = await run("create_use_case", {
    name: "Odd",
    selector: { taskIds: ["t"], variant: "a" },
  });
  assert.equal(unknown.ok === false && unknown.error, "invalid_params");
  const taken = await run("create_use_case", { name: "Taken", selector: { taskIds: ["t"] } });
  assert.equal(taken.ok === false && taken.error, "conflict");
  assert.equal(calls.tracked, 1);
});

test("every tool refuses as forbidden with FF_FINE_TUNING off, and reads or writes nothing", async () => {
  const { run, calls } = harness({ fineTuningEnabled: async () => false });
  for (const [id, params] of [
    ["list_use_cases", {}],
    ["get_use_case", { useCaseId: USE_CASE_ID }],
    ["create_use_case", { name: "Triage", selector: { taskIds: ["triage"] } }],
    ["build_dataset", { useCaseId: USE_CASE_ID }],
    ["get_dataset", { datasetId: DATASET_ID }],
  ] as const) {
    const result = await run(id, params);
    assert.ok(!result.ok);
    assert.equal(result.error, "forbidden", id);
    assert.equal(result.reason, "fine_tuning_off", id);
  }
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.builds, []);
});

test("build_dataset starts a build as the key's project and returns the building version", async () => {
  const { run, calls } = harness();
  const built = await run("build_dataset", {
    useCaseId: USE_CASE_ID,
    settings: { seed: 3, dedup: "exact" },
  });
  assert.ok(built.ok, JSON.stringify(built));
  assert.equal((built.data as { status: string }).status, "building");
  assert.deepEqual(calls.builds, [
    {
      projectId: PROJECT,
      useCaseId: USE_CASE_ID,
      input: {
        seed: 3,
        dedup: "exact",
        filters: { noError: false, noSelfCorrection: false },
        evalFraction: 0.1,
      },
      actor: `project:${PROJECT}`,
    },
  ]);
  const missing = await run("build_dataset", { useCaseId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(missing.ok === false && missing.error, "not_found");
  const bad = await run("build_dataset", {
    useCaseId: USE_CASE_ID,
    settings: { evalFraction: 0.9 },
  });
  assert.equal(bad.ok === false && bad.error, "invalid_params");
});

test("with no training opt-in, build_dataset refuses with reason no_consent and a message that names the opt-in", async () => {
  const { run } = harness({
    buildDataset: async () => ({
      ok: false,
      reason: "no_consent",
      message: "An organization admin must give the training opt-in first.",
    }),
  });
  const refused = await run("build_dataset", { useCaseId: USE_CASE_ID });
  assert.ok(!refused.ok);
  assert.equal(refused.error, "forbidden");
  assert.equal(refused.reason, "no_consent");
  assert.match(refused.message, /opt-in/);
});

test("get_dataset returns status, counts, the redaction report and settings, and no row text", async () => {
  const { run } = harness();
  const got = await run("get_dataset", { datasetId: DATASET_ID });
  assert.ok(got.ok);
  const data = got.data as Record<string, unknown>;
  assert.equal(data.status, "ready");
  const { cursor: _cursor, ...shown } = DATASET.counts!;
  assert.deepEqual(data.counts, shown, "the counts, without the job's resume cursor");
  assert.deepEqual(data.redactionReport, DATASET.redactionReport);
  assert.equal((data.settings as { dedup: string }).dedup, "near");
  assert.deepEqual(
    Object.keys(data).filter((key) => /^(rows|content|messages|output)$/.test(key)),
    [],
  );
  assert.equal(JSON.stringify(data).includes('"role"'), false, "no message of a row");
  const missing = await run("get_dataset", { datasetId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(missing.ok === false && missing.error, "not_found");
});
