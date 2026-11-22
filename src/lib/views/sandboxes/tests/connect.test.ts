import assert from "node:assert/strict";
import { test } from "node:test";
import { type ResolveProjectDeps, resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { handleRunnerConnect, type RunnerConnectDeps } from "../connect";
import { verifySandboxToken } from "../domain/token";

const SECRET = "x".repeat(44);
const NOW = new Date("2026-11-20T10:00:00Z");
const VALID = "rtl_valid";

interface Key {
  id: string;
  projectId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMinute: number | null;
  createdBy: string | null;
}

function keyDeps(keys: Record<string, Key>): ResolveProjectDeps {
  return {
    isDbConfigured: () => true,
    hashApiKey: (plaintext) => plaintext,
    findActiveApiKeyByHash: async (hash) => keys[hash] ?? null,
    touchApiKey: async () => {},
  };
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    id: "k1",
    projectId: "p1",
    keyPrefix: "rtl_ab",
    scopes: ["*"],
    rateLimitPerMinute: null,
    createdBy: "user_owner",
    ...overrides,
  };
}

function setup(options: { keys?: Record<string, Key>; enabled?: boolean; secret?: string } = {}) {
  const tracked: unknown[] = [];
  const deps: RunnerConnectDeps = {
    resolveKey: (req, scope) =>
      resolveProjectFromBearer(req, scope, keyDeps(options.keys ?? { [VALID]: key() })),
    organizationIdOf: async () => "o1",
    sandboxesEnabled: async () => options.enabled ?? true,
    tokenSecret: () => ("secret" in options ? options.secret : SECRET),
    gatewayUrl: () => "ws://localhost:8787",
    now: () => NOW,
    trackConnected: async (context, properties) => {
      tracked.push({ context, properties });
    },
  };
  return { deps, tracked };
}

function request(token = VALID): Request {
  return new Request("http://localhost/api/v1/runner/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

test("a valid key with cloud-sandboxes on gets a 15-minute token bound to the project and the key's creator", async () => {
  const { deps, tracked } = setup();
  const res = await handleRunnerConnect(request(), "ingest:traces", deps);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { gatewayUrl: string; token: string; expiresAt: string };
  assert.equal(body.gatewayUrl, "ws://localhost:8787");
  assert.equal((body as { projectId?: string }).projectId, "p1");
  assert.equal(body.expiresAt, "2026-11-20T10:15:00.000Z");
  const verified = verifySandboxToken(body.token, SECRET, NOW);
  assert.ok(verified.ok);
  assert.deepEqual(
    {
      projectId: verified.claims.projectId,
      organizationId: verified.claims.organizationId,
      ownerUserId: verified.claims.ownerUserId,
      apiKeyId: verified.claims.apiKeyId,
    },
    { projectId: "p1", organizationId: "o1", ownerUserId: "user_owner", apiKeyId: "k1" },
  );
  assert.deepEqual(tracked, [
    { context: { projectId: "p1", orgId: "o1" }, properties: { api_key_id: "k1" } },
  ]);
});

test("cloud-sandboxes off for the organization answers 404", async () => {
  const { deps, tracked } = setup({ enabled: false });
  const res = await handleRunnerConnect(request(), "ingest:traces", deps);
  assert.equal(res.status, 404);
  assert.deepEqual(tracked, []);
});

test("a bad or revoked key answers 401", async () => {
  const { deps } = setup();
  assert.equal(
    (await handleRunnerConnect(request("rtl_revoked"), "ingest:traces", deps)).status,
    401,
  );
  const noHeader = new Request("http://localhost/api/v1/runner/connect", { method: "POST" });
  assert.equal((await handleRunnerConnect(noHeader, "ingest:traces", deps)).status, 401);
});

test("a publishable key and a key without a recorded creator get no token", async () => {
  const publishable = setup({
    keys: { [VALID]: key({ scopes: ["ingest:traces", "ingest:logs", "ingest:events"] }) },
  });
  const res1 = await handleRunnerConnect(request(), "ingest:traces", publishable.deps);
  assert.equal(res1.status, 403);
  assert.equal(((await res1.json()) as { reason: string }).reason, "publishable_key");

  const legacy = setup({ keys: { [VALID]: key({ createdBy: null }) } });
  const res2 = await handleRunnerConnect(request(), "ingest:traces", legacy.deps);
  assert.equal(res2.status, 403);
  assert.equal(((await res2.json()) as { reason: string }).reason, "key_without_owner");
});

test("a missing secret answers 503 and the response never carries the secret", async () => {
  const { deps } = setup({ secret: undefined });
  const res = await handleRunnerConnect(request(), "ingest:traces", deps);
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes(SECRET));
});
