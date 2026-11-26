import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createLocalBundleStore } from "../adapters/local-bundle-store";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "../gate";
import { runImageBuild } from "../image-build-job";
import {
  handleCreateVersion,
  handleFinalizeVersion,
  handleGetVersion,
  handleListVersions,
  handleUploadBundle,
  type PushApiDeps,
} from "../push-api";
import { type AgentScript, scriptAgent } from "./fake-agent";
import { createFakeProvider } from "./fake-provider";
import {
  bundleInfo,
  COMMIT,
  CONFIG,
  createSandboxDb,
  IMAGE,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  tarGz,
} from "./support";

const BUNDLE = tarGz([{ name: "manifest.json", body: "[]" }]);
const SEALING = Buffer.alloc(32, 9);
const WRITE = BEARER_ROUTE_SCOPES["POST /api/v1/sandboxes/versions"];
const READ = BEARER_ROUTE_SCOPES["GET /api/v1/sandboxes"];
const KEYS: Record<string, { projectId: string; scopes: string[] }> = {
  full: { projectId: PROJECT_ID, scopes: ["*"] },
  read: { projectId: PROJECT_ID, scopes: ["sandboxes:read"] },
  ingest: { projectId: PROJECT_ID, scopes: ["ingest:traces"] },
  other: { projectId: OTHER_PROJECT_ID, scopes: ["*"] },
};
const ON = resolveConfig({ env: { FF_SANDBOXES: "1" } });
const GET = new Request("http://10.0.0.7:3000/x");

type Over = {
  key?: string;
  scope?: typeof WRITE | typeof READ;
  limits?: Parameters<typeof createInMemoryUsageLimits>[0];
  on?: boolean;
  provider?: boolean;
  origin?: string | null;
};

async function setup() {
  const { db, client } = await createSandboxDb();
  const bundles = createLocalBundleStore(mkdtempSync(join(tmpdir(), "bundles-")));
  const uploaded: string[] = [];
  const records: unknown[] = [];
  const secrets = createDrizzleSecretStore(db);
  const sealed = sealSecret(SEALING, { projectId: PROJECT_ID, name: "OPENAI_API_KEY" }, "sk-1");
  await secrets.set(PROJECT_ID, "OPENAI_API_KEY", sealed, "user_1");
  const vms = createFakeProvider();
  const agent = (script?: AgentScript) => scriptAgent(vms, script);
  agent();
  /** The build job of a version, as the worker runs it after the push. */
  const prepare = (versionId: string) =>
    runImageBuild(
      PROJECT_ID,
      { versionId },
      {
        builds: createDrizzleBuildStore(db),
        bundles,
        provider: vms,
        secrets,
        sealingKey: () => ({ ok: true, key: SEALING }),
        enabled: async () => true,
        now: () => new Date(),
        every: () => () => {},
      },
    );
  const deps = ({
    key = "full",
    scope = WRITE,
    limits,
    on = true,
    provider = true,
    origin = "https://ratel.example",
  }: Over = {}) => {
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
      publicOrigin: () => origin,
    } satisfies PushApiDeps;
  };
  const create = (over?: Over, body: unknown = input()) =>
    handleCreateVersion(post(JSON.stringify(body)), deps(over));
  const upload = (id: string, body: Buffer = BUNDLE, over?: Over) =>
    handleUploadBundle(post(body), id, deps(over));
  const finalize = (id: string, over?: Over) => handleFinalizeVersion(GET, id, deps(over));
  const get = (id: string, over?: Over) =>
    handleGetVersion(GET, id, deps({ scope: READ, ...over }));
  const list = (over?: Over) => handleListVersions(GET, deps({ scope: READ, ...over }));
  const push = async (over?: Over) => {
    const { versionId } = await read(await create(over));
    await upload(versionId);
    return { versionId, finalized: await finalize(versionId) };
  };
  return {
    client,
    deps,
    create,
    upload,
    finalize,
    get,
    list,
    push,
    prepare,
    agent,
    vms,
    uploaded,
    records,
  };
}

test("a push stores the version with its config, image, commit and tarball", async () => {
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
  const finalized = await t.finalize(body.versionId);
  assert.equal(finalized.status, 202);
  assert.equal((await read(finalized)).status, "uploaded");
  const version = await read(await t.get(body.versionId));
  assert.equal(version.status, "uploaded");
  assert.equal(version.name, CONFIG.name);
  assert.deepEqual(version.config, CONFIG);
  assert.deepEqual(version.image, IMAGE);
  assert.deepEqual(version.git, { commit: COMMIT, dirty: true });
  assert.deepEqual(version.bundle, bundleInfo(BUNDLE));
  assert.equal(version.url, `https://ratel.example/project/${PROJECT_ID}/sandbox`);
  assert.equal("manifest" in version, false);
  assert.deepEqual(t.uploaded, [body.versionId]);
});

test("a valid push goes preparing, then ready, with its smoke result through the version API", async () => {
  const t = await setup();
  const { versionId } = await t.push();
  const statuses: string[] = [];
  const startVm = t.vms.startVm;
  t.vms.startVm = async (request) => {
    statuses.push((await read(await t.get(versionId))).status);
    return startVm(request);
  };
  assert.deepEqual(await t.prepare(versionId), { status: "ready" });
  const version = await read(await t.get(versionId));
  assert.deepEqual(statuses, ["preparing"]);
  assert.equal(version.status, "ready");
  assert.equal(version.reason, null);
  assert.deepEqual(version.config, CONFIG);
  assert.equal(version.smoke.ok, true);
  assert.deepEqual(version.smoke.output, { reply: "refunded" });
  assert.equal(typeof version.smoke.durationMs, "number");
  assert.equal(JSON.stringify(version).includes(`rv-${versionId}`), false, "no snapshot name");
  assert.equal(t.vms.snapshots.size, 1);
  assert.equal(t.vms.vms.size, 0);
});

const FAILURES: Array<[string, AgentScript, string]> = [
  ["no health", { health: "never" }, "no_health"],
  ["not JSON", { answer: { status: 200, body: "ok" } }, "not_json"],
  ["not a run response", { answer: { status: 200, body: '{"text":"hi"}' } }, "invalid_response"],
  ["a 500 with no error", { answer: { status: 500, body: "{}" } }, "invalid_error"],
];

for (const [what, script, code] of FAILURES) {
  test(`a smoke check with ${what} gives failed with ${code} and the logs through the version API`, async () => {
    const t = await setup();
    t.agent({ ...script, logs: "agent booted\n" });
    const { versionId } = await t.push();
    assert.deepEqual(await t.prepare(versionId), { status: "failed" });
    const version = await read(await t.get(versionId));
    assert.equal(version.status, "failed");
    assert.equal(version.smoke.ok, false);
    assert.equal(version.smoke.error.code, code);
    assert.equal(version.reason, version.smoke.error.message);
    assert.equal(version.smoke.logs, "agent booted\n");
    assert.equal(t.vms.snapshots.size, 0);
    assert.equal(t.vms.vms.size, 0);
  });
}

test("command mode: a non-zero exit gives failed with stderr through the version API", async () => {
  const t = await setup();
  t.agent({ command: { exitCode: 2, stderr: "no input\n" } });
  const config = {
    name: "cli",
    run: { mode: "command", command: ["./agent"] },
    input: { example: 1 },
  };
  const { versionId } = await read(await t.create({}, { ...input(), config }));
  await t.upload(versionId);
  await t.finalize(versionId);
  await t.prepare(versionId);
  const version = await read(await t.get(versionId));
  assert.equal(version.status, "failed");
  assert.equal(version.smoke.error.code, "run_failed");
  assert.equal(version.smoke.logs, "no input\n");
});

test("with no public origin the upload address is the origin that the client called", async () => {
  const t = await setup();
  const created = await handleCreateVersion(
    new Request("http://10.0.0.7:3000/api/v1/sandboxes/versions", {
      method: "POST",
      headers: { "x-forwarded-host": "staging.ratel.sh", "x-forwarded-proto": "https" },
      body: JSON.stringify(input()),
    }),
    t.deps({ origin: null }),
  );
  const { versionId, upload } = await read(created);
  assert.equal(
    upload.url,
    `https://staging.ratel.sh/api/v1/sandboxes/versions/${versionId}/bundle`,
  );
  const direct = await handleCreateVersion(post(JSON.stringify(input())), t.deps({ origin: null }));
  assert.match((await read(direct)).upload.url, /^http:\/\/x\/api\/v1\/sandboxes\/versions\//);
});

test("an invalid ratel.yaml is refused with its path, and no version or VM starts", async () => {
  const t = await setup();
  const bad = [
    [
      { ...CONFIG, params: { model: { type: "enum", options: ["a"], default: "b" } } },
      /^config\.params\.model\.default: /,
    ],
    [{ ...CONFIG, entry: "src/agent.ts" }, /^config\.entry: /],
    [
      { ...CONFIG, secrets: ["RATEL_TOKEN"] },
      /^config\.secrets\.0: The prefix of this name is reserved/,
    ],
    [{ ...CONFIG, input: {} }, /^config\.input\.example: /],
  ] as const;
  for (const [config, message] of bad) {
    const refused = await t.create({}, { ...input(), config });
    assert.equal(refused.status, 400);
    const body = await read(refused);
    assert.equal(body.error, "invalid");
    assert.match(body.message, message);
  }
  assert.deepEqual((await read(await t.list())).versions, []);
  assert.equal(t.vms.starts.length, 0);
});

test("a tarball over the size limit is refused with the limit, and no VM starts", async () => {
  const t = await setup();
  const refused = await t.create({ limits: { sandbox_bundle_bytes: 10 } });
  assert.equal(refused.status, 413);
  const body = await read(refused);
  assert.deepEqual(
    [body.error, body.limit, body.max],
    ["limit_reached", "sandbox_bundle_bytes", 10],
  );
  assert.match(body.message, /sandbox_bundle_bytes/);
  assert.deepEqual((await read(await t.list())).versions, []);
  assert.equal(t.vms.starts.length, 0);
});

test("a push with no git information has a null git", async () => {
  const t = await setup();
  const { git: _, ...noGit } = input();
  const { versionId } = await read(await t.create({}, noGit));
  assert.equal((await read(await t.get(versionId))).git, null);
});

test("two pushes of the same folder give two versions, and the first does not change", async () => {
  const t = await setup();
  const first = await t.push();
  await t.prepare(first.versionId);
  const before = await read(await t.get(first.versionId));
  assert.equal(before.status, "ready");
  const second = await t.push();
  await t.prepare(second.versionId);
  assert.notEqual(first.versionId, second.versionId);
  assert.deepEqual(await read(await t.get(first.versionId)), before);
  const list = await read(await t.list());
  assert.deepEqual(
    list.versions.map((v: { versionId: string }) => v.versionId).sort(),
    [first.versionId, second.versionId].sort(),
  );
});

test("no route changes a stored version", async () => {
  const t = await setup();
  const { versionId } = await t.push();
  const before = await read(await t.get(versionId));
  const other = tarGz([{ name: "other", body: "x" }]);
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
  const list = await read(await t.list({ key }));
  assert.deepEqual(list.versions, []);
  assert.equal((await t.get("not-a-uuid")).status, 404);
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
  assert.doesNotMatch(body.message, /boat/i);
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
      await t.list(off),
    ];
    assert.deepEqual(
      answers.map((response) => response.status),
      [404, 404, 404, 404, 404],
    );
  }
});

function input() {
  return {
    config: CONFIG,
    image: IMAGE,
    git: { commit: COMMIT, dirty: true },
    bundle: bundleInfo(BUNDLE),
  };
}

function post(body: string | Buffer): Request {
  return new Request("http://x", { method: "POST", body: body as BodyInit });
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON as it is
async function read(response: Response): Promise<any> {
  return response.json();
}
