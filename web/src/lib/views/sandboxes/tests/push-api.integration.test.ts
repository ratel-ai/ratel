import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createLocalBundleStore } from "../adapters/local-bundle-store";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "../gate";
import {
  handleCreateVersion,
  handleFinalizeVersion,
  handleGetVersion,
  handleListVersions,
  handleUploadBundle,
  type PushApiDeps,
} from "../push-api";
import {
  bundleInfo,
  COMMIT,
  createSandboxDb,
  MANIFEST,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  tarGz,
} from "./support";

const BUNDLE = tarGz([{ name: "src/agent.ts", body: "export default () => 1;" }]);
const WRITE = BEARER_ROUTE_SCOPES["POST /api/v1/sandboxes/versions"];
const READ = BEARER_ROUTE_SCOPES["GET /api/v1/sandboxes"];
const KEYS: Record<string, { projectId: string; scopes: string[] }> = {
  full: { projectId: PROJECT_ID, scopes: ["*"] },
  read: { projectId: PROJECT_ID, scopes: ["sandboxes:read"] },
  ingest: { projectId: PROJECT_ID, scopes: ["ingest:traces"] },
  other: { projectId: OTHER_PROJECT_ID, scopes: ["*"] },
};
const ON = resolveConfig({ env: { FF_SANDBOXES: "1" } });

type Over = {
  key?: string;
  scope?: typeof WRITE | typeof READ;
  limits?: Parameters<typeof createInMemoryUsageLimits>[0];
  on?: boolean;
  provider?: boolean;
};

async function setup() {
  const { db, client } = await createSandboxDb();
  const bundles = createLocalBundleStore(mkdtempSync(join(tmpdir(), "bundles-")));
  const uploaded: string[] = [];
  const records: unknown[] = [];
  const deps = ({ key = "full", scope = WRITE, limits, on = true, provider = true }: Over = {}) => {
    const usage = createInMemoryUsageLimits(limits);
    const config = on ? ON : resolveConfig();
    return {
      offForAll: () => sandboxesOffForAll({ config, port: undefined, edition: "Ratel OSS" }),
      authenticate: () =>
        resolveProjectFromBearer(
          new Request("http://x", { headers: { authorization: `Bearer ${key}` } }),
          scope,
          {
            isDbConfigured: () => true,
            hashApiKey: (plaintext) => plaintext,
            findActiveApiKeyByHash: async (hash) => {
              const found = KEYS[hash];
              if (!found) return null;
              const id = "99999999-9999-4999-8999-999999999999";
              return { id, keyPrefix: "rtl", rateLimitPerMinute: null, ...found };
            },
            touchApiKey: async () => {},
          },
        ),
      enabled: (projectId) =>
        sandboxesEnabledForProject(projectId, { config, port: undefined, edition: "Ratel OSS" }),
      organizationIdOf: async () => ORGANIZATION_ID,
      versions: () => createDrizzleVersionStore(db),
      bundles: () => bundles,
      limits: () => ({
        ...usage,
        record: async (subject, usageRecord) => {
          records.push({ ...subject, ...usageRecord });
        },
      }),
      providerConfigured: () => provider,
      onUploaded: async (version) => {
        uploaded.push(version.id);
      },
      publicUrl: (path) => `https://ratel.example${path}`,
    } satisfies PushApiDeps;
  };
  const create = (over?: Over, body: unknown = input()) =>
    handleCreateVersion(post(JSON.stringify(body)), deps(over));
  const upload = (id: string, body: Buffer = BUNDLE, over?: Over) =>
    handleUploadBundle(post(body), id, deps(over));
  const finalize = (id: string, over?: Over) => handleFinalizeVersion(id, deps(over));
  const get = (id: string, over?: Over) => handleGetVersion(id, deps({ scope: READ, ...over }));
  const push = async (over?: Over) => {
    const { versionId } = await read(await create(over));
    await upload(versionId);
    return { versionId, finalized: await finalize(versionId) };
  };
  return { client, deps, create, upload, finalize, get, push, uploaded, records };
}

test("a push stores the version with its commit, its dirty flag and its bundle", async () => {
  const t = await setup();
  const created = await t.create();
  assert.equal(created.status, 201);
  const body = await read(created);
  assert.deepEqual(body.upload, {
    method: "PUT",
    url: `https://ratel.example/api/v1/sandboxes/versions/${body.versionId}/bundle`,
    headers: { "content-type": "application/gzip" },
    authorize: true,
  });
  assert.equal((await t.upload(body.versionId)).status, 204);
  assert.equal((await t.finalize(body.versionId)).status, 202);
  const version = await read(await t.get(body.versionId));
  assert.equal(version.status, "uploaded");
  assert.deepEqual(version.git, { commit: COMMIT, dirty: true });
  assert.deepEqual(version.bundle, bundleInfo(BUNDLE));
  assert.deepEqual(version.manifest, MANIFEST);
  assert.deepEqual(t.uploaded, [body.versionId]);
});

test("two pushes of the same folder give two versions, and the first does not change", async () => {
  const t = await setup();
  const first = await t.push();
  const before = await read(await t.get(first.versionId));
  const second = await t.push();
  assert.notEqual(first.versionId, second.versionId);
  assert.deepEqual(await read(await t.get(first.versionId)), before);
  const list = await read(await handleListVersions(t.deps({ scope: READ })));
  assert.deepEqual(
    list.versions.map((v: { versionId: string }) => v.versionId).sort(),
    [first.versionId, second.versionId].sort(),
  );
});

test("no route changes a stored version", async () => {
  const t = await setup();
  const { versionId } = await t.push();
  const before = await read(await t.get(versionId));
  const other = tarGz([{ name: "other.ts", body: "x" }]);
  assert.equal((await t.upload(versionId, other)).status, 409);
  assert.equal((await t.upload(versionId)).status, 409);
  assert.equal((await t.finalize(versionId)).status, 202);
  assert.deepEqual(await read(await t.get(versionId)), before);
  assert.deepEqual(t.uploaded, [versionId], "the second finalize starts nothing");
});

test("finalize without a bundle, and an upload of another bundle, are refused", async () => {
  const t = await setup();
  const { versionId } = await read(await t.create());
  assert.equal((await read(await t.finalize(versionId))).error, "not_uploaded");
  const wrong = await t.upload(versionId, Buffer.concat([BUNDLE, Buffer.from("x")]));
  assert.equal((await read(wrong)).error, "bundle_mismatch");
  assert.equal((await t.upload(versionId)).status, 204, "the right bundle still fits");
});

test("a bundle with a ../ entry is refused", async () => {
  const t = await setup();
  const evil = tarGz([{ name: "../evil.sh", body: "x" }]);
  const { versionId } = await read(await t.create({}, { ...input(), bundle: bundleInfo(evil) }));
  await t.upload(versionId, evil);
  const refused = await t.finalize(versionId);
  assert.equal(refused.status, 422);
  assert.match((await read(refused)).message, /leaves the project folder/);
  assert.equal((await read(await t.get(versionId))).status, "failed");
  assert.deepEqual(t.uploaded, []);
});

test("a key needs the scope", async () => {
  const t = await setup();
  assert.equal((await t.create({ key: "ingest" })).status, 403);
  assert.equal((await t.create({ key: "read" })).status, 403);
  const { versionId } = await t.push();
  assert.equal((await t.upload(versionId, BUNDLE, { key: "read" })).status, 403);
  assert.equal((await t.finalize(versionId, { key: "read" })).status, 403);
  assert.equal((await t.get(versionId, { key: "read" })).status, 200);
  assert.equal((await t.get(versionId, { key: "ingest" })).status, 403);
  assert.equal((await t.create({ key: "unknown" })).status, 401);
});

test("a key of another project cannot read, upload or finalize the version", async () => {
  const t = await setup();
  const { versionId } = await read(await t.create());
  const key = "other";
  assert.equal((await t.get(versionId, { key })).status, 404);
  assert.equal((await t.upload(versionId, BUNDLE, { key })).status, 404);
  assert.equal((await t.finalize(versionId, { key })).status, 404);
  const list = await read(await handleListVersions(t.deps({ key, scope: READ })));
  assert.deepEqual(list.versions, []);
  assert.equal((await t.get("not-a-uuid")).status, 404);
});

test("a bundle over the size limit is refused with the limit name", async () => {
  const t = await setup();
  const refused = await t.create({ limits: { sandbox_bundle_bytes: 10 } });
  assert.equal(refused.status, 413);
  const body = await read(refused);
  assert.equal(body.error, "limit_reached");
  assert.equal(body.limit, "sandbox_bundle_bytes");
  assert.equal(body.max, 10);
});

test("a push over the daily limit is refused with the limit name, for its project only", async () => {
  const t = await setup();
  const limits = { sandbox_versions_per_day: 2 };
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await t.create({ limits })).status);
  assert.deepEqual(statuses, [201, 201, 429]);
  const body = await read(await t.create({ limits }));
  assert.deepEqual([body.limit, body.max, body.current], ["sandbox_versions_per_day", 2, 2]);
  assert.match(body.message, /sandbox_versions_per_day/);
  assert.equal((await t.create({ limits, key: "other" })).status, 201);
  await t.client.exec("update sandbox_versions set created_at = now() - interval '25 hours'");
  assert.equal((await t.create({ limits })).status, 201);
});

test("each created version is recorded one time", async () => {
  const t = await setup();
  const { versionId } = await t.push();
  assert.deepEqual(t.records, [
    {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      kind: "sandbox_version",
      reference: versionId,
    },
  ]);
});

test("with no provider a push is refused with the reason, and the reason does not name one", async () => {
  const t = await setup();
  const refused = await t.create({ provider: false });
  assert.equal(refused.status, 503);
  const body = await read(refused);
  assert.equal(body.error, "not_configured");
  assert.match(body.message, /not configured/);
  assert.doesNotMatch(body.message, /modal/i);
});

test("a body that is not a push is refused", async () => {
  const t = await setup();
  for (const body of [null, {}, { ...input(), git: { commit: "main", dirty: false } }]) {
    assert.equal((await t.create({}, body)).status, 400);
  }
});

test("with the flag off every route answers 404, with and without a key", async () => {
  const t = await setup();
  const { versionId } = await t.push();
  for (const key of ["full", "unknown"]) {
    const off = { on: false, key };
    const answers = [
      await t.create(off),
      await t.upload(versionId, BUNDLE, off),
      await t.finalize(versionId, off),
      await t.get(versionId, off),
      await handleListVersions(t.deps({ ...off, scope: READ })),
    ];
    assert.deepEqual(
      answers.map((response) => response.status),
      [404, 404, 404, 404, 404],
    );
  }
});

function input() {
  return { manifest: MANIFEST, git: { commit: COMMIT, dirty: true }, bundle: bundleInfo(BUNDLE) };
}

function post(body: string | Buffer): Request {
  return new Request("http://x", { method: "POST", body: body as BodyInit });
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON as it is
async function read(response: Response): Promise<any> {
  return response.json();
}

test("a refused bundle fails its version, and the check does not run again", async () => {
  const t = await setup();
  const bad = tarGz([{ name: "../evil.sh", body: "x" }]);
  const { versionId } = await read(await t.create({}, { ...input(), bundle: bundleInfo(bad) }));
  assert.equal((await t.upload(versionId, bad)).status, 204);
  const first = await t.finalize(versionId);
  assert.equal(first.status, 422);
  const version = await read(await t.get(versionId));
  assert.equal(version.status, "failed");
  assert.match(version.reason, /leaves the project/);
  assert.equal((await t.finalize(versionId)).status, 202);
});

test("a manifest with a NUL character is refused", async () => {
  const t = await setup();
  const manifest = { ...MANIFEST, install: ["npm\0install"] };
  assert.equal((await t.create({}, { ...input(), manifest })).status, 400);
});
