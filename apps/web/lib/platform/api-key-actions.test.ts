import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApiKeyActionContext,
  type ApiKeyActionDeps,
  type ApiKeyRecord,
  createApiKeyHandler,
  MAX_API_KEYS_PER_PROJECT,
  revokeApiKeyHandler,
  toApiKeySummary,
} from "@/lib/platform/api-key-actions";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

const context: ApiKeyActionContext = {
  user: { externalId: "user_1" },
  organization: { id: "22222222-2222-4222-8222-222222222222", slug: "acme" },
};

function record(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "key-1",
    projectId: PROJECT_ID,
    name: null,
    keyPrefix: "rtl_abcd1234",
    createdAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...over,
  };
}

function deps(overrides: Partial<ApiKeyActionDeps> = {}): ApiKeyActionDeps {
  return {
    isDbConfigured: () => true,
    getContext: async () => ({ ok: true, context }),
    getProjectBySlug: async () => ({ id: PROJECT_ID }),
    listApiKeysForProject: async () => [],
    findApiKeyForProject: async () => record(),
    generateApiKey: () => ({
      plaintext: "rtl_abcd1234secret",
      prefix: "rtl_abcd1234",
      hash: "hash",
    }),
    createApiKey: async (input) => record({ name: input.name, expiresAt: input.expiresAt }),
    revokeApiKey: async () => undefined,
    trackApiKeyCreated: async () => undefined,
    trackApiKeyRevoked: async () => undefined,
    logInfo: () => undefined,
    revalidatePath: () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

/* — Gating ————————————————————————————————————————————————————————————————— */

test("a project from another organization is not reachable", async () => {
  const unreachable = deps({
    getProjectBySlug: async () => null,
    createApiKey: async () => assert.fail("must not create"),
    revokeApiKey: async () => assert.fail("must not revoke"),
  });

  assert.deepEqual(await createApiKeyHandler({ projectSlug: "theirs" }, undefined, unreachable), {
    ok: false,
    error: "Project not found.",
  });
  assert.deepEqual(
    await revokeApiKeyHandler({ projectSlug: "theirs", keyId: "key-1" }, undefined, unreachable),
    { ok: false, error: "Project not found." },
  );
});

/* — Create ————————————————————————————————————————————————————————————————— */

test("creating a key leaves the project's existing keys untouched", async () => {
  let revoked = 0;
  const result = await createApiKeyHandler(
    { projectSlug: "agent", name: "Staging" },
    undefined,
    deps({
      listApiKeysForProject: async () => [record({ id: "key-existing" })],
      revokeApiKey: async () => {
        revoked += 1;
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(revoked, 0, "creating must never rotate other keys");
  assert.equal(result.ok === true ? result.plaintext : null, "rtl_abcd1234secret");
  assert.equal(result.ok === true ? result.key.name : null, "Staging");
  assert.equal(result.ok === true ? result.key.status : null, "active");
});

test("the plaintext is returned once and never appears in the summary", async () => {
  const result = await createApiKeyHandler({ projectSlug: "agent" }, undefined, deps());

  assert.equal(result.ok, true);
  const summary = result.ok === true ? result.key : null;
  assert.ok(summary);
  assert.equal(
    JSON.stringify(summary).includes("secret"),
    false,
    "the stored summary must not carry the secret",
  );
});

test("the chosen lifetime is resolved server-side into a stored instant", async () => {
  let stored: Date | null | undefined;
  const result = await createApiKeyHandler(
    { projectSlug: "agent", expiresIn: "3mo" },
    undefined,
    deps({
      createApiKey: async (input) => {
        stored = input.expiresAt;
        return record({ expiresAt: input.expiresAt });
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(stored?.toISOString(), "2026-11-10T12:00:00.000Z");
});

test("omitting the lifetime issues a key that never expires", async () => {
  let stored: Date | null | undefined;
  await createApiKeyHandler(
    { projectSlug: "agent" },
    undefined,
    deps({
      createApiKey: async (input) => {
        stored = input.expiresAt;
        return record({ expiresAt: input.expiresAt });
      },
    }),
  );

  assert.equal(stored, null);
});

test("a lifetime outside the offered set is rejected before a key is issued", async () => {
  const result = await createApiKeyHandler(
    { projectSlug: "agent", expiresIn: "99y" as never },
    undefined,
    deps({ createApiKey: async () => assert.fail("must not create") }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /offered expiration/);
});

test("an over-long name is rejected before a key is issued", async () => {
  const result = await createApiKeyHandler(
    { projectSlug: "agent", name: "x".repeat(100) },
    undefined,
    deps({ createApiKey: async () => assert.fail("must not create") }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /64 characters or fewer/);
});

test("a project cannot grow past the key cap", async () => {
  const full = Array.from({ length: MAX_API_KEYS_PER_PROJECT }, (_, i) =>
    record({ id: `key-${i}` }),
  );
  const result = await createApiKeyHandler(
    { projectSlug: "agent" },
    undefined,
    deps({
      listApiKeysForProject: async () => full,
      createApiKey: async () => assert.fail("must not create"),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /Revoke one before/);
});

test("creating emits a typed event and a structured log", async () => {
  const events: unknown[] = [];
  const logs: Array<[Record<string, unknown>, string]> = [];
  await createApiKeyHandler(
    { projectSlug: "agent", name: "CI", expiresIn: "3mo" },
    undefined,
    deps({
      trackApiKeyCreated: async (_ctx, projectId, details) => {
        events.push({ projectId, ...details });
      },
      logInfo: (fields, message) => logs.push([fields, message]),
    }),
  );

  assert.deepEqual(events, [
    {
      projectId: PROJECT_ID,
      keyPrefix: "rtl_abcd1234",
      named: true,
      expiresIn: "3mo",
    },
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], "issued api key");
  assert.equal(logs[0][0].keyPrefix, "rtl_abcd1234");
});

/* — Revoke ————————————————————————————————————————————————————————————————— */

test("revoking takes down exactly the key asked for", async () => {
  const revoked: string[] = [];
  const result = await revokeApiKeyHandler(
    { projectSlug: "agent", keyId: "key-1" },
    undefined,
    deps({
      revokeApiKey: async (id) => {
        revoked.push(id);
      },
    }),
  );

  assert.deepEqual(result, { ok: true, keyId: "key-1" });
  assert.deepEqual(revoked, ["key-1"]);
});

test("a key belonging to another project is not revocable", async () => {
  const result = await revokeApiKeyHandler(
    { projectSlug: "agent", keyId: "key-elsewhere" },
    undefined,
    deps({
      findApiKeyForProject: async () => null,
      revokeApiKey: async () => assert.fail("must not revoke"),
    }),
  );

  assert.deepEqual(result, { ok: false, error: "API key not found." });
});

test("revoking an already-revoked key succeeds without a second write", async () => {
  const result = await revokeApiKeyHandler(
    { projectSlug: "agent", keyId: "key-1" },
    undefined,
    deps({
      findApiKeyForProject: async () => record({ revokedAt: NOW }),
      revokeApiKey: async () => assert.fail("must not revoke twice"),
      trackApiKeyRevoked: async () => assert.fail("must not double-count"),
    }),
  );

  assert.deepEqual(result, { ok: true, keyId: "key-1" });
});

test("revoking emits a typed event and a structured log", async () => {
  const events: unknown[] = [];
  const logs: Array<[Record<string, unknown>, string]> = [];
  await revokeApiKeyHandler(
    { projectSlug: "agent", keyId: "key-1" },
    undefined,
    deps({
      trackApiKeyRevoked: async (_ctx, projectId, details) => {
        events.push({ projectId, ...details });
      },
      logInfo: (fields, message) => logs.push([fields, message]),
    }),
  );

  assert.deepEqual(events, [{ projectId: PROJECT_ID, keyPrefix: "rtl_abcd1234" }]);
  assert.equal(logs[0][1], "revoked api key");
});

/* — Summary ———————————————————————————————————————————————————————————————— */

test("a summary carries the display fields the key list needs", () => {
  const summary = toApiKeySummary(
    record({
      name: "CI",
      lastUsedAt: new Date("2026-08-09T00:00:00.000Z"),
      expiresAt: new Date("2026-08-09T00:00:00.000Z"),
    }),
    NOW,
  );

  assert.deepEqual(summary, {
    id: "key-1",
    name: "CI",
    keyPrefix: "rtl_abcd1234",
    createdAt: "2026-08-10T12:00:00.000Z",
    lastUsedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:00:00.000Z",
    status: "expired",
  });
});
