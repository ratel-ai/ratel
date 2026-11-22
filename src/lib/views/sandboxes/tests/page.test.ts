import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSandboxesPage, loadSandboxPage, type SandboxesPageDeps } from "../page";
import type { SandboxRunnerView } from "../ports/store";
import { checkRunRequest } from "../run-request";

/**
 * The Sandboxes pages' loaders: the caller's own runner (online first), its
 * manifest sandboxes, and for one sandbox the code-default and production config
 * hashes the config pill compares.
 */

const ME = "user_me";
const SANDBOX = {
  id: "workflow-label",
  file: "lib/trace-signals/workflows/label.sandbox.ts",
  modelResolver: "builtin",
  input: {
    kind: "structured",
    schema: { type: "object", properties: { workflowId: { type: "string" } } },
  },
  params: [
    { name: "model", kind: "model", default: "anthropic/claude-sonnet-5-5" },
    { name: "maxTokens", kind: "scalar", type: "int", default: 400, min: 50, max: 2000 },
  ],
  context: [],
};
const MANIFEST = {
  sdk: { language: "typescript", name: "@ratel-ai/sandbox", version: "0.1.0" },
  build: { id: "4fb449eb0000000000000000000000000000beef", dirty: true },
  providers: [{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }],
  sandboxes: [
    SANDBOX,
    { id: "chatty", modelResolver: "builtin", input: { kind: "chat" }, params: [], context: [] },
  ],
};

function runner(overrides: Partial<SandboxRunnerView>): SandboxRunnerView {
  return {
    id: "r",
    ownerUserId: ME,
    instanceId: "rnr",
    online: true,
    manifest: MANIFEST,
    maxConcurrency: 2,
    connectedAt: new Date("2026-11-20T10:00:00Z"),
    lastSeenAt: new Date("2026-11-20T10:05:00Z"),
    ...overrides,
  };
}

const ITEM = {
  spanId: "81c583215710d8a3",
  traceId: "7b55d114b56c0667506050ec608264fd",
  startedAt: new Date("2026-11-19T10:00:00Z"),
  input: { workflowId: "wf" },
  recordedOutput: { name: "A" },
};

function deps(
  runners: SandboxRunnerView[],
  productionHash: string | null = null,
): SandboxesPageDeps {
  return {
    listRunners: async () => runners,
    productionConfigHash: async () => productionHash,
    recordedItems: async (query) =>
      query.spanIds?.includes(ITEM.spanId) && query.sandboxId === "workflow-label" ? [ITEM] : [],
    now: () => new Date("2026-11-20T12:00:00Z"),
  };
}

test("the list shows the sandboxes of the caller's online runner, not another user's", async () => {
  const model = await loadSandboxesPage(
    { projectId: "p", externalId: ME },
    deps([
      runner({ id: "theirs", ownerUserId: "user_them" }),
      runner({ id: "old", online: false }),
      runner({ id: "mine" }),
    ]),
  );

  assert.equal(model.runner?.id, "mine");
  assert.equal(model.runner?.online, true);
  assert.deepEqual(model.runner?.build, { sha: "4fb449e", dirty: true });
  assert.equal(model.runner?.maxConcurrency, 2);
  assert.deepEqual(model.sandboxes, [
    {
      id: "workflow-label",
      file: "lib/trace-signals/workflows/label.sandbox.ts",
      inputKind: "structured",
      paramCount: 2,
    },
    { id: "chatty", file: null, inputKind: "chat", paramCount: 0 },
  ]);
});

test("with only an offline runner the list is paused, and with none it is empty", async () => {
  const paused = await loadSandboxesPage(
    { projectId: "p", externalId: ME },
    deps([runner({ online: false })]),
  );
  assert.equal(paused.runner?.online, false);

  const none = await loadSandboxesPage(
    { projectId: "p", externalId: ME },
    deps([runner({ ownerUserId: "user_them" })]),
  );
  assert.equal(none.runner, null);
  assert.deepEqual(none.sandboxes, []);
});

test("the sandbox page carries the code-default hash a run with no edits gets, and the production hash", async () => {
  const model = await loadSandboxPage(
    { projectId: "p", externalId: ME, sandboxId: "workflow-label" },
    deps([runner({})], "prod-hash"),
  );

  assert.ok(model.sandbox);
  assert.equal(model.sandbox.id, "workflow-label");
  assert.deepEqual(model.providers, MANIFEST.providers);
  const baseline = checkRunRequest(SANDBOX as never, { workflowId: "x" }, {});
  assert.ok(baseline.ok);
  assert.equal(model.defaultConfigHash, baseline.configHash);
  assert.equal(model.productionHash, "prod-hash");
});

test("a sandbox the runner does not have gives no sandbox", async () => {
  const model = await loadSandboxPage(
    { projectId: "p", externalId: ME, sandboxId: "nope" },
    deps([runner({})]),
  );
  assert.equal(model.sandbox, null);
  assert.equal(model.runner?.id, "r");
});

test("the sandbox page opens the recorded item named by ?span, and none for an unknown span", async () => {
  const opened = await loadSandboxPage(
    { projectId: "p", externalId: ME, sandboxId: "workflow-label", spanId: ITEM.spanId },
    deps([runner({})]),
  );
  assert.deepEqual(opened.item, {
    spanId: ITEM.spanId,
    traceId: ITEM.traceId,
    startedAt: "2026-11-19T10:00:00.000Z",
    input: { workflowId: "wf" },
    recordedOutput: { name: "A" },
  });

  const unknown = await loadSandboxPage(
    { projectId: "p", externalId: ME, sandboxId: "workflow-label", spanId: "beef" },
    deps([runner({})]),
  );
  assert.equal(unknown.item, null);
  const none = await loadSandboxPage(
    { projectId: "p", externalId: ME, sandboxId: "workflow-label" },
    deps([runner({})]),
  );
  assert.equal(none.item, null);
});
