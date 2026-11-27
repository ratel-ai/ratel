import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { Organization } from "@/lib/contracts/session";
import { hashApiKey } from "@/lib/platform/api-keys";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type ApiKeyDb,
  createApiKey,
  findActiveApiKeyByHash,
  revokeApiKey,
} from "@/lib/platform/projects/queries";
import { internalSecret, isInternalAuthorization, refuseInternalRequest } from "./bearer";
import { handleKeyResolve, type KeyResolveDeps } from "./key-resolve";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const VALUE = "s".repeat(44);
const on = { internal: { secret: VALUE } };
const LIMITS = { shared: null, events: { perMinute: 120, burst: 240 } };

async function setup(over: Partial<KeyResolveDeps> = {}) {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Support', 'support');
  `);
  const db = drizzle(client, { schema }) as unknown as ApiKeyDb;
  const deps: KeyResolveDeps = {
    config: on,
    isDbConfigured: () => true,
    findActiveApiKeyByHash: (hash) => findActiveApiKeyByHash(hash, async () => {}, db),
    getOrganizationByProjectId: async () =>
      ({ id: ORG, name: "Acme", slug: "acme" }) as unknown as Organization,
    limitsFor: () => LIMITS,
    isMetered: async () => false,
    monthlyEventLimit: () => 50_000,
    checkEventQuota: async () => ({ ok: true }),
    ...over,
  };
  const add = (plaintext: string, key: Partial<schema.NewApiKey> = {}) =>
    createApiKey(
      {
        projectId: PROJECT,
        keyHash: hashApiKey(plaintext),
        keyPrefix: plaintext.slice(0, 12),
        ...key,
      },
      db,
    );
  const resolve = async (body: unknown, authorization: string | null = `Bearer ${VALUE}`) => {
    const res = await handleKeyResolve(
      new Request("https://app.test/api/internal/keys/resolve", {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps,
    );
    return { status: res.status, body: await res.json() };
  };
  return { db, deps, add, resolve };
}

test("internal auth: off without a long enough value, exact match only", () => {
  for (const secret of [undefined, "", "a".repeat(31)]) {
    const off = { internal: { secret } };
    assert.equal(internalSecret(off), null);
    assert.equal(isInternalAuthorization(`Bearer ${secret ?? "undefined"}`, off), false);
    const request = new Request("https://app.test/x", {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(refuseInternalRequest(request, off)?.status, 404);
  }
  assert.equal(isInternalAuthorization(`Bearer ${VALUE}`, on), true);
  for (const header of [null, VALUE, "Bearer ", `Bearer ${VALUE}x`, `Bearer ${VALUE.slice(1)}`]) {
    assert.equal(isInternalAuthorization(header, on), false, String(header));
  }
});

test("found: every field of docs/internal-api.md", async () => {
  const { add, resolve } = await setup();
  const key = await add("rtl_secret", { scopes: ["*"] });
  assert.deepEqual(await resolve({ keyHash: hashApiKey("rtl_secret") }), {
    status: 200,
    body: {
      found: true,
      keyId: key.id,
      projectId: PROJECT,
      organizationId: ORG,
      scopes: ["*"],
      ingest: ["ingest:traces", "ingest:logs", "ingest:events"],
      expiresAt: null,
      keyPolicy: {
        access: "full",
        publishable: false,
        sharedKeyLimits: false,
        appendOnlyIngest: false,
      },
      limits: LIMITS,
      quota: { limit: 50_000, used: null, exceeded: false },
    },
  });
});

test("the quota: over the cap, unlimited, and metered", async () => {
  const over = await setup({
    checkEventQuota: async () => ({ ok: false, plan: "free", limit: 10, used: 12, message: "m" }),
  });
  await over.add("rtl_a", { scopes: ["*"] });
  const body = { keyHash: hashApiKey("rtl_a") };
  assert.deepEqual((await over.resolve(body)).body.quota, { limit: 10, used: 12, exceeded: true });
  over.deps.isMetered = async () => true;
  const none = { limit: null, used: null, exceeded: false };
  assert.deepEqual((await over.resolve(body)).body.quota, none);
  over.deps.isMetered = async () => false;
  over.deps.checkEventQuota = async () => ({ ok: true });
  over.deps.monthlyEventLimit = () => Number.POSITIVE_INFINITY;
  assert.deepEqual((await over.resolve(body)).body.quota, none);
});

test("revoked, expired and unknown keys are not found", async () => {
  const { db, add, resolve } = await setup();
  await revokeApiKey((await add("rtl_revoked")).id, db);
  await add("rtl_expired", { expiresAt: new Date("2020-01-01T00:00:00Z") });
  for (const plaintext of ["rtl_revoked", "rtl_expired", "rtl_unknown"]) {
    assert.deepEqual(
      await resolve({ keyHash: hashApiKey(plaintext) }),
      { status: 200, body: { found: false } },
      plaintext,
    );
  }
});

test("refused without the shared value, for a project key, for a bad body, and 503 on a failure", async () => {
  const { add, resolve, deps } = await setup();
  await add("rtl_secret", { scopes: ["*"] });
  const body = { keyHash: hashApiKey("rtl_secret") };
  assert.equal((await resolve(body, null)).status, 401);
  assert.equal((await resolve(body, "Bearer rtl_secret")).status, 401);
  for (const bad of ["{", "null", { keyHash: "rtl_secret" }, {}]) {
    assert.equal((await resolve(bad)).status, 400);
  }
  deps.findActiveApiKeyByHash = async () => {
    throw new Error("db down");
  };
  assert.equal((await resolve(body)).status, 503);
  deps.config = { internal: { secret: undefined } };
  assert.equal((await resolve(body)).status, 404);
});
