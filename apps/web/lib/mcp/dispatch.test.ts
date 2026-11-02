import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { McpAuthContext } from "./auth";
import { dispatchOperation, type ProjectOwnerLookup, resolveScope } from "./dispatch";
import { McpOperationError } from "./errors";
import { buildRegistry, defineOperation, type McpOperation } from "./registry";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

const apiKeyAuth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function op(overrides: Partial<McpOperation> = {}): McpOperation {
  return {
    id: "demo_op",
    domain: "catalog",
    title: "Demo",
    description: "demo operation",
    scope: "project",
    mutates: false,
    params: z.object({
      projectId: z.string().uuid().optional(),
      count: z.number().int().min(1).optional(),
    }),
    async execute(ctx) {
      return { data: { projectId: ctx.projectId } };
    },
    ...overrides,
  } as McpOperation;
}

function registryOf(...operations: McpOperation[]) {
  return buildRegistry(operations.length ? operations : [op()]);
}

test("a known operation runs and the project is pre-filled from the key", async () => {
  const result = await dispatchOperation(
    "demo_op",
    {},
    {
      registry: registryOf(),
      auth: apiKeyAuth,
    },
  );

  assert.ok(result.ok);
  assert.deepEqual(result.data, { projectId: PROJECT });
});

test("an unknown operation is refused rather than silently doing nothing", async () => {
  const result = await dispatchOperation(
    "demo_ops",
    {},
    {
      registry: registryOf(),
      auth: apiKeyAuth,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "unknown_operation");
  assert.match(result.message, /tools\/list/);
});

test("a foreign projectId is refused rather than silently redirected", async () => {
  const result = await dispatchOperation(
    "demo_op",
    { projectId: OTHER_PROJECT },
    { registry: registryOf(), auth: apiKeyAuth },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "forbidden");
});

test("invalid params are rejected with per-field issues", async () => {
  const result = await dispatchOperation(
    "demo_op",
    { count: 0 },
    {
      registry: registryOf(),
      auth: apiKeyAuth,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "invalid_params");
  assert.equal(result.issues?.[0]?.path, "count");
});

test("an operation error surfaces its own code", async () => {
  const failing = op({
    id: "missing_op",
    async execute() {
      throw new McpOperationError("not_found", "No skill found.");
    },
  });
  const result = await dispatchOperation(
    "missing_op",
    {},
    {
      registry: registryOf(failing),
      auth: apiKeyAuth,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "not_found");
});

test("an unexpected error is logged and reported opaquely", async () => {
  const errors: unknown[] = [];
  const failing = op({
    id: "boom_op",
    async execute() {
      throw new Error("connection string postgres://user:pw@host/db");
    },
  });

  const result = await dispatchOperation(
    "boom_op",
    {},
    {
      registry: registryOf(failing),
      auth: apiKeyAuth,
      logger: {
        error: (fields: unknown) => errors.push(fields),
        info: () => {},
      } as never,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "internal");
  assert.ok(!result.message.includes("postgres://"), "must not leak the cause");
  assert.equal(errors.length, 1);
});

test("a statement timeout becomes a retryable timeout code", async () => {
  const failing = op({
    id: "slow_op",
    async execute() {
      throw Object.assign(new Error("canceling statement"), { code: "57014" });
    },
  });

  const result = await dispatchOperation(
    "slow_op",
    {},
    {
      registry: registryOf(failing),
      auth: apiKeyAuth,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error, "timeout");
});

test("outcomes are reported once per dispatch for analytics", async () => {
  const outcomes: string[] = [];
  await dispatchOperation(
    "demo_op",
    {},
    {
      registry: registryOf(),
      auth: apiKeyAuth,
      onOutcome: (outcome) => outcomes.push(outcome.code),
    },
  );

  assert.deepEqual(outcomes, ["ok"]);
});

test("scope none does not require or resolve a project", () => {
  const scope = resolveScope(apiKeyAuth, op({ scope: "none" }), undefined);
  assert.equal(scope.projectId, "");
});

test("an oauth caller must name the project explicitly", () => {
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_123",
    userId: "u1",
    memberships: [],
  };

  assert.throws(
    () => resolveScope(oauth, op(), undefined),
    (error: unknown) => {
      assert.ok(error instanceof McpOperationError);
      assert.equal(error.code, "invalid_params");
      return true;
    },
  );
});

/**
 * OAuth callers reach many projects, so a token proves identity and never
 * access. These pin that membership decides, and that a probe cannot learn
 * which project ids exist in other tenants.
 */
const oauthAuth: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_123",
  userId: "u1",
  memberships: [
    {
      organizationId: "org-mine",
      role: "admin",
      organization: { id: "org-mine", slug: "mine", effectivePlan: "pro" },
    },
  ],
};

const ownedByMine: ProjectOwnerLookup = async () => ({ organizationId: "org-mine" });
const ownedByOther: ProjectOwnerLookup = async () => ({ organizationId: "org-theirs" });
const missing: ProjectOwnerLookup = async () => null;

test("an oauth caller reaches a project in an organization they belong to", async () => {
  const result = await dispatchOperation(
    "demo_op",
    { projectId: PROJECT },
    { registry: registryOf(), auth: oauthAuth, projectOwner: ownedByMine },
  );

  assert.ok(result.ok);
  assert.deepEqual(result.data, { projectId: PROJECT });
});

test("a project in someone else's organization is not_found, never forbidden", async () => {
  const result = await dispatchOperation(
    "demo_op",
    { projectId: PROJECT },
    { registry: registryOf(), auth: oauthAuth, projectOwner: ownedByOther },
  );

  assert.ok(!result.ok);
  // `forbidden` would confirm the id exists, turning this into an oracle.
  assert.equal(result.error, "not_found");
});

test("a project that does not exist is indistinguishable from one you cannot see", async () => {
  const mine = await dispatchOperation(
    "demo_op",
    { projectId: PROJECT },
    { registry: registryOf(), auth: oauthAuth, projectOwner: missing },
  );
  const theirs = await dispatchOperation(
    "demo_op",
    { projectId: PROJECT },
    { registry: registryOf(), auth: oauthAuth, projectOwner: ownedByOther },
  );

  assert.ok(!mine.ok);
  assert.ok(!theirs.ok);
  assert.deepEqual(
    { error: mine.error, message: mine.message },
    { error: theirs.error, message: theirs.message },
  );
});

test("an api-key caller skips the ownership lookup entirely", async () => {
  let looked = false;
  const result = await dispatchOperation(
    "demo_op",
    {},
    {
      registry: registryOf(),
      auth: apiKeyAuth,
      projectOwner: async () => {
        looked = true;
        return { organizationId: "org-1" };
      },
    },
  );

  assert.ok(result.ok);
  assert.equal(looked, false, "the key already names its one project");
});

/**
 * Writes have no switch of their own any more. Nothing in the product is behind
 * a flag, so a caller that may act on a project may also change it: a key on its
 * one project, a member on their organization's. Membership still decides, the
 * same way it does for a read.
 */
const writeOperation = defineOperation({
  id: "test_write",
  domain: "writes",
  title: "Test write",
  description: "A mutating operation, for write tests.",
  scope: "project",
  mutates: true,
  params: z.object({ projectId: z.string().uuid().optional() }),
  async execute() {
    return { data: { wrote: true } };
  },
});

const writeRegistry = buildRegistry([writeOperation]);

test("a write runs for every caller, with no write switch to turn on first", async () => {
  const viaKey = await dispatchOperation(
    "test_write",
    {},
    {
      registry: writeRegistry,
      auth: apiKeyAuth,
    },
  );
  const viaMember = await dispatchOperation(
    "test_write",
    { projectId: PROJECT },
    { registry: writeRegistry, auth: oauthAuth, projectOwner: ownedByMine },
  );

  assert.ok(viaKey.ok, "a key that can read its project can also write to it");
  assert.deepEqual(viaKey.data, { wrote: true });
  assert.ok(viaMember.ok, "a member needs nothing for a write that a read does not need");
  assert.deepEqual(viaMember.data, { wrote: true });
});

test("a write is still counted as a mutation, so the dashboard can tell it from a read", async () => {
  const outcomes: Array<{ code: string; mutates: boolean }> = [];
  await dispatchOperation(
    "test_write",
    {},
    {
      registry: writeRegistry,
      auth: apiKeyAuth,
      onOutcome: (outcome) => outcomes.push({ code: outcome.code, mutates: outcome.mutates }),
    },
  );

  assert.deepEqual(outcomes, [{ code: "ok", mutates: true }]);
});
