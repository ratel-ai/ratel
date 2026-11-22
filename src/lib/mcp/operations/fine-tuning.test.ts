import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Dataset } from "@/lib/views/fine-tuning/domain/dataset";
import type { UseCaseOverride } from "@/lib/views/fine-tuning/domain/overrides";
import { emptyCounts } from "@/lib/views/fine-tuning/domain/redaction";
import { buildSettings, emptyDrops } from "@/lib/views/fine-tuning/domain/rows";
import type { UseCase } from "@/lib/views/fine-tuning/domain/use-case";
import type { ListedRow } from "@/lib/views/fine-tuning/ports/store";
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

const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const TURN_ID = "88888888-8888-4888-8888-888888888888";
const ROWS: ListedRow[] = [0, 1, 2].map((ordinal) => ({
  ordinal,
  side: ordinal === 1 ? "eval" : "train",
  content: {
    system: "Be brief.",
    messages: [{ role: "user", content: `ask ${ordinal}` }],
    output: [{ role: "assistant", content: "ok" }],
  },
  traceId: `trace-${ordinal}`,
  spanId: `span-${ordinal}`,
  turnId: ordinal === 0 ? TURN_ID : "99999999-9999-4999-8999-999999999999",
  capturedAt: new Date("2026-11-19T00:00:00.000Z"),
}));
const OVERRIDE: UseCaseOverride = {
  turnId: TURN_ID,
  pinned: false,
  excluded: true,
  setBy: `project:${PROJECT}`,
  updatedAt: new Date("2026-11-20T00:00:00.000Z"),
};

/** Every fake answers for PROJECT only, as the real stores do: another project finds nothing. */
const ours = (projectId: string) => projectId === PROJECT;

function harness(
  overrides: Partial<FineTuningOperationDeps> = {},
  authOverride: McpAuthContext = auth,
) {
  const calls = {
    created: [] as unknown[],
    tracked: 0,
    reads: 0,
    builds: [] as unknown[],
    overrides: [] as unknown[],
    events: [] as string[],
    deleted: [] as string[],
  };
  const deps: FineTuningOperationDeps = {
    fineTuningEnabled: async () => true,
    listUseCases: async (projectId) => {
      calls.reads++;
      return ours(projectId) ? [USE_CASE] : [];
    },
    getUseCase: async (projectId, id) => {
      calls.reads++;
      return ours(projectId) && id === USE_CASE_ID ? USE_CASE : null;
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
      if (!ours(projectId) || useCaseId !== USE_CASE_ID)
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
    getDataset: async (projectId, id) => {
      calls.reads++;
      return ours(projectId) && id === DATASET_ID ? DATASET : null;
    },
    listRows: async (projectId, id, query) => {
      calls.reads++;
      if (!ours(projectId) || id !== DATASET_ID) return [];
      return ROWS.filter(
        (row) =>
          (query.side === null || row.side === query.side) &&
          (query.after === null || row.ordinal > query.after),
      ).slice(0, query.limit);
    },
    listOverrides: async (projectId, useCaseId) =>
      ours(projectId) && useCaseId === USE_CASE_ID ? [OVERRIDE] : [],
    setOverride: async (projectId, useCaseId, input, actor) => {
      calls.overrides.push({ projectId, useCaseId, input, actor });
      if (!ours(projectId) || useCaseId !== USE_CASE_ID)
        return { ok: false, reason: "use_case_not_found" };
      return {
        ok: true,
        override: { ...OVERRIDE, pinned: input.pinned ?? false, excluded: input.excluded ?? false },
      };
    },
    trackOverride: async (_context, event) => {
      calls.events.push(`${event.name}:${event.value}`);
    },
    deleteDataset: async (projectId, id) => {
      if (!ours(projectId) || id !== DATASET_ID || calls.deleted.includes(id)) return false;
      calls.deleted.push(id);
      return true;
    },
    trackLifecycle: async (_context, event) => {
      calls.events.push(event.name);
    },
    contentAccess: { contentOptIn: async () => true },
    ...overrides,
  };
  const run = (operationId: string, params: unknown) =>
    dispatchOperation(
      operationId,
      { projectId: PROJECT, ...(params as object) },
      { registry: buildRegistry(fineTuningOperations(deps)), auth: authOverride },
    );
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
    ["list_dataset_rows", { datasetId: DATASET_ID }],
    ["set_use_case_override", { useCaseId: USE_CASE_ID, turnId: TURN_ID, excluded: true }],
    ["delete_dataset", { datasetId: DATASET_ID }],
  ] as const) {
    const result = await run(id, params);
    assert.ok(!result.ok);
    assert.equal(result.error, "forbidden", id);
    assert.equal(result.reason, "fine_tuning_off", id);
  }
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.builds, []);
  assert.deepEqual(calls.overrides, []);
  assert.deepEqual(calls.deleted, []);
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
        scorers: "on",
        filters: { noError: false, noSelfCorrection: false },
        evalFraction: 0.1,
      },
      actor: `project:${PROJECT}`,
    },
  ]);
  const off = await run("build_dataset", { useCaseId: USE_CASE_ID, settings: { scorers: "off" } });
  assert.ok(off.ok, JSON.stringify(off));
  assert.equal(
    (calls.builds[1]!.input as { scorers: string }).scorers,
    "off",
    "RC-1177: the scorer filter can be turned off",
  );
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
  assert.deepEqual(
    data.counts,
    {
      ...shown,
      scorerDrops: { runs: 0, calls: 0, byKind: {} },
      exportSkipped: null,
      exportSkipReasons: null,
    },
    "the counts, without the job's resume cursor",
  );
  assert.equal(
    data.consoleUrl,
    `/project/${PROJECT}/fine-tuning/${USE_CASE_ID}?dataset=${DATASET_ID}`,
  );
  assert.deepEqual(data.exportUrls, {
    train: `/api/projects/${PROJECT}/fine-tuning/datasets/${DATASET_ID}/export?side=train`,
    eval: `/api/projects/${PROJECT}/fine-tuning/datasets/${DATASET_ID}/export?side=eval`,
  });
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

test("list_dataset_rows pages in ordinal order, filters by side, and marks the runs the use case excluded", async () => {
  const { run } = harness();
  const first = await run("list_dataset_rows", { datasetId: DATASET_ID, limit: 2 });
  assert.ok(first.ok, JSON.stringify(first));
  const page = first.data as {
    rows: { ordinal: number; excluded: boolean; content: unknown }[];
    nextCursor: string | null;
    contentWithheld?: true;
  };
  assert.deepEqual(
    page.rows.map((row) => row.ordinal),
    [0, 1],
  );
  assert.equal(page.rows[0]?.excluded, true);
  assert.deepEqual(page.rows[0]?.content, ROWS[0]!.content);
  assert.equal(page.contentWithheld, undefined);
  assert.ok(page.nextCursor);
  const second = await run("list_dataset_rows", {
    datasetId: DATASET_ID,
    limit: 2,
    cursor: page.nextCursor,
  });
  assert.ok(second.ok);
  assert.deepEqual(
    (second.data as typeof page).rows.map((row) => row.ordinal),
    [2],
  );
  assert.equal((second.data as typeof page).nextCursor, null);

  const evalOnly = await run("list_dataset_rows", { datasetId: DATASET_ID, side: "eval" });
  assert.ok(evalOnly.ok);
  assert.deepEqual(
    (evalOnly.data as typeof page).rows.map((row) => row.ordinal),
    [1],
  );
  const wrongSide = await run("list_dataset_rows", {
    datasetId: DATASET_ID,
    side: "eval",
    cursor: page.nextCursor,
  });
  assert.equal(wrongSide.ok === false && wrongSide.error, "invalid_params");
  const missing = await run("list_dataset_rows", {
    datasetId: "66666666-6666-4666-8666-666666666666",
  });
  assert.equal(missing.ok === false && missing.error, "not_found");
});

test("list_dataset_rows withholds row text from a key without content:read or with read_content off, and returns it to an OAuth member", async () => {
  const cases: [string, McpAuthContext, boolean, boolean][] = [
    ["key without content:read", { ...auth, scopes: ["mcp:read"] }, true, false],
    [
      "key with content:read, read_content off",
      { ...auth, scopes: ["mcp:read", "content:read"] },
      false,
      false,
    ],
    [
      "key with content:read, read_content on",
      { ...auth, scopes: ["mcp:read", "content:read"] },
      true,
      true,
    ],
    ["OAuth member, read_content off", OAUTH, false, true],
  ];
  for (const [name, caller, optIn, readable] of cases) {
    const { run } = harness({ contentAccess: { contentOptIn: async () => optIn } }, caller);
    const result = await run("list_dataset_rows", { datasetId: DATASET_ID });
    assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
    const data = result.data as {
      rows: { content: unknown; turnId: string; side: string }[];
      contentWithheld?: true;
    };
    assert.equal(data.rows.length, 3, name);
    assert.equal(data.rows[0]?.turnId, TURN_ID, `${name}: the source stays`);
    if (readable) {
      assert.equal(data.contentWithheld, undefined, name);
      assert.deepEqual(data.rows[0]?.content, ROWS[0]!.content, name);
    } else {
      assert.equal(data.contentWithheld, true, name);
      assert.ok(
        data.rows.every((row) => row.content === null),
        name,
      );
      assert.equal(JSON.stringify(data).includes("ask 0"), false, `${name}: no row text`);
      assert.match(result.hint ?? "", /content/, name);
    }
  }
});

test("set_use_case_override excludes or pins a run as the key's project, emits one event per field, and refuses an empty change", async () => {
  const { run, calls } = harness();
  const excluded = await run("set_use_case_override", {
    useCaseId: USE_CASE_ID,
    turnId: TURN_ID,
    excluded: true,
  });
  assert.ok(excluded.ok, JSON.stringify(excluded));
  assert.equal((excluded.data as { excluded: boolean }).excluded, true);
  assert.match(excluded.hint ?? "", /next|build_dataset/);
  const pinned = await run("set_use_case_override", {
    useCaseId: USE_CASE_ID,
    turnId: TURN_ID,
    pinned: true,
  });
  assert.ok(pinned.ok);
  assert.deepEqual(calls.overrides, [
    {
      projectId: PROJECT,
      useCaseId: USE_CASE_ID,
      input: { turnId: TURN_ID, pinned: undefined, excluded: true },
      actor: `project:${PROJECT}`,
    },
    {
      projectId: PROJECT,
      useCaseId: USE_CASE_ID,
      input: { turnId: TURN_ID, pinned: true, excluded: undefined },
      actor: `project:${PROJECT}`,
    },
  ]);
  assert.deepEqual(calls.events, ["dataset_row_excluded:true", "dataset_row_pinned:true"]);

  const empty = await run("set_use_case_override", { useCaseId: USE_CASE_ID, turnId: TURN_ID });
  assert.equal(empty.ok === false && empty.error, "invalid_params");
  const missing = await run("set_use_case_override", {
    useCaseId: "66666666-6666-4666-8666-666666666666",
    turnId: TURN_ID,
    excluded: true,
  });
  assert.equal(missing.ok === false && missing.error, "not_found");
  assert.equal(calls.events.length, 2);
});

test("delete_dataset deletes the version as the key's project and emits dataset_deleted; a second delete is not found", async () => {
  const { run, calls } = harness();
  const deleted = await run("delete_dataset", { datasetId: DATASET_ID });
  assert.ok(deleted.ok, JSON.stringify(deleted));
  assert.deepEqual(deleted.data, { deleted: DATASET_ID, version: 1 });
  assert.deepEqual(calls.deleted, [DATASET_ID]);
  assert.deepEqual(calls.events, ["dataset_deleted"]);
  const again = await run("delete_dataset", { datasetId: DATASET_ID });
  assert.equal(again.ok === false && again.error, "not_found");
  const other = await run("delete_dataset", { datasetId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(other.ok === false && other.error, "not_found");
  assert.deepEqual(calls.events, ["dataset_deleted"]);
});

test("RC-1177: get_dataset shows the runs and calls each task scorer kind left out", async () => {
  const scorerDrops = {
    runs: 3,
    calls: 4,
    byKind: { max_latency_ms: { runs: 2, calls: 3 }, max_cost_usd: { runs: 2, calls: 2 } },
  };
  const dataset: Dataset = {
    ...DATASET,
    counts: { ...DATASET.counts!, dropped: { ...emptyDrops(), scorer_failed: 4 }, scorerDrops },
  };
  const { run } = harness({
    getDataset: async (projectId, id) =>
      projectId === PROJECT && id === DATASET_ID ? dataset : null,
  });
  const got = await run("get_dataset", { datasetId: DATASET_ID });
  assert.ok(got.ok);
  assert.deepEqual(
    (got.data as { counts: { scorerDrops: unknown } }).counts.scorerDrops,
    scorerDrops,
  );
  assert.equal((got.data as { settings: { scorers: string } }).settings.scorers, "on");
});
