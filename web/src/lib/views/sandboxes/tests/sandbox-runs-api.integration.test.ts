import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import { EVAL_TRIAL_PREFIX, sandboxRunSchema } from "../domain/run";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "../gate";
import { ProviderRefused } from "../ports/sandbox-provider";
import { type RunDeps, startRun } from "../runs";
import {
  handleGetSandboxRun,
  handleStartSandboxRun,
  type SandboxRunsApiDeps,
} from "../sandbox-runs-api";
import { scriptAgent } from "./fake-agent";
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

const SEALING = Buffer.alloc(32, 9);
const RUN = BEARER_ROUTE_SCOPES["POST /api/v1/sandbox-runs"];
const READ = BEARER_ROUTE_SCOPES["GET /api/v1/sandbox-runs/[id]"];
const KEYS: Record<string, { projectId: string; scopes: string[] }> = {
  full: { projectId: PROJECT_ID, scopes: ["*"] },
  read: { projectId: PROJECT_ID, scopes: ["sandboxes:read"] },
  push: { projectId: PROJECT_ID, scopes: ["sandboxes:write"] },
  other: { projectId: OTHER_PROJECT_ID, scopes: ["*"] },
  runner: { projectId: PROJECT_ID, scopes: ["sandboxes:run", "sandboxes:read"] },
};
/** Each key has its own id: a run names the key that started it. */
const KEY_IDS: Record<string, string> = {
  full: "99999999-9999-4999-8999-999999999999",
  read: "99999999-9999-4999-8999-999999999998",
  push: "99999999-9999-4999-8999-999999999997",
  other: "99999999-9999-4999-8999-999999999996",
  runner: "99999999-9999-4999-8999-999999999995",
};
const ON = resolveConfig({ env: { FF_EVALS: "1" } });

type Over = {
  key?: string;
  scope?: typeof RUN | typeof READ;
  on?: boolean;
  limits?: Parameters<typeof createInMemoryUsageLimits>[0];
  /** The project lets Ratel read captured text. Default on. */
  optIn?: boolean;
};

async function setup() {
  const { db } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const secrets = createDrizzleSecretStore(db);
  const sealed = sealSecret(SEALING, { projectId: PROJECT_ID, name: "OPENAI_API_KEY" }, "sk-1");
  await secrets.set(PROJECT_ID, "OPENAI_API_KEY", sealed, "user_1");
  const provider = createFakeProvider();
  scriptAgent(provider);
  const builds = createDrizzleBuildStore(db);
  /** A version of the sandbox, ready unless `ready` is false. */
  const push = async (ready = true) => {
    const bundle = tarGz([{ name: "a", body: "x" }]);
    const created = await versions.create(
      {
        projectId: PROJECT_ID,
        apiKeyId: null,
        config: CONFIG,
        image: IMAGE,
        git: { commit: COMMIT, dirty: false },
        bundle: bundleInfo(bundle),
      },
      async () => ({ ok: true }),
    );
    assert.ok(created.ok);
    const { id } = created.version;
    if (!ready) return id;
    await versions.markUploaded(PROJECT_ID, id);
    await builds.claim(PROJECT_ID, id, new Date());
    provider.snapshots.set(`rv-${id}`, new Map());
    const smoke = { ok: true as const, output: 1, durationMs: 1, logs: "" };
    await builds.finish(id, { status: "ready", imageRef: `rv-${id}`, smoke, log: "" }, new Date());
    return id;
  };
  const pending: Array<Promise<void>> = [];
  const deps = ({ key = "full", scope = RUN, on = true, limits, optIn = true }: Over = {}) => {
    const config = on ? ON : resolveConfig();
    const runDeps: RunDeps = {
      runs: createDrizzleRunStore(db),
      vms: createDrizzleVmStore(db),
      versions,
      secrets,
      provider,
      limits: createInMemoryUsageLimits(limits),
      sealingKey: () => ({ ok: true, key: SEALING }),
      callbackUrl: () => "https://ratel.example",
      now: () => new Date(),
      background: (work) => {
        pending.push(work());
      },
    };
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
              const id = KEY_IDS[hash] ?? "99999999-9999-4999-8999-999999999999";
              return { id, keyPrefix: "rtl", rateLimitPerMinute: null, ...found };
            },
            touchApiKey: async () => {},
          },
        ),
      enabled: (projectId) =>
        sandboxesEnabledForProject(projectId, { config, port: undefined, edition: "Ratel OSS" }),
      organizationIdOf: async () => ORGANIZATION_ID,
      versions: () => versions,
      runDeps: () => runDeps,
      publicOrigin: () => "https://ratel.example",
      contentOptIn: async () => optIn,
    } satisfies SandboxRunsApiDeps;
  };
  const start = async (body: unknown, over?: Over) => {
    const request = new Request("http://x/api/v1/sandbox-runs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const response = await handleStartSandboxRun(request, deps(over));
    return { status: response.status, body: await response.json() };
  };
  const get = async (id: string, over?: Over) => {
    const request = new Request(`http://x/api/v1/sandbox-runs/${id}`);
    const response = await handleGetSandboxRun(request, id, deps({ scope: READ, ...over }));
    return { status: response.status, body: await response.json() };
  };
  const settle = async () => {
    for (let work = pending.shift(); work; work = pending.shift()) await work;
  };
  return { push, start, get, settle, provider, runDeps: () => deps().runDeps() };
}

test("POST /api/v1/sandbox-runs runs the newest ready version of a name; GET answers the sandbox-run", async () => {
  const t = await setup();
  const older = await t.push();
  const newest = await t.push();
  await t.push(false);
  const started = await t.start({
    name: "support-agent",
    input: { message: "hi" },
    params: { model: "large" },
    tools: { refund_order: { mode: "recorded" } },
  });
  assert.equal(started.status, 202);
  assert.ok(sandboxRunSchema.safeParse(started.body).success, JSON.stringify(started.body));
  assert.equal(started.body.versionId, newest);
  assert.notEqual(started.body.versionId, older);
  assert.equal(started.body.status, "queued");
  assert.deepEqual(started.body.input, { message: "hi" });
  assert.equal(started.body.params.model, "large");
  assert.equal(
    started.body.url,
    `https://ratel.example/project/${PROJECT_ID}/sandboxes/${CONFIG.name}`,
  );
  await t.settle();
  const read = await t.get(started.body.runId);
  assert.equal(read.status, 200);
  assert.ok(sandboxRunSchema.safeParse(read.body).success);
  assert.equal(read.body.status, "completed");
  assert.deepEqual(read.body.output, { reply: "refunded" });
  assert.equal(read.body.logs, "");
  assert.equal(JSON.stringify(read.body).includes("vm-"), false, "no VM reference");
});

test("a run by version id, and a failed run with its error", async () => {
  const t = await setup();
  const versionId = await t.push();
  scriptAgent(t.provider, { health: "never" });
  const started = await t.start({ versionId, input: null });
  assert.equal(started.status, 202);
  await t.settle();
  const read = await t.get(started.body.runId);
  assert.ok(sandboxRunSchema.safeParse(read.body).success);
  assert.equal(read.body.status, "failed");
  assert.equal(read.body.error.code, "no_health");
});

test("a refusal of the sandbox service is a failed run with provider_refused and a safe message", async () => {
  const t = await setup();
  const versionId = await t.push();
  const startVm = t.provider.startVm;
  t.provider.startVm = async () => {
    throw new ProviderRefused("boat: billing_required (status 402)", 402);
  };
  const started = await t.start({ versionId, input: null });
  assert.equal(started.status, 202);
  await t.settle();
  t.provider.startVm = startVm;
  const read = await t.get(started.body.runId);
  assert.equal(read.status, 200);
  assert.ok(sandboxRunSchema.safeParse(read.body).success);
  assert.equal(read.body.status, "failed");
  assert.deepEqual(read.body.error, {
    code: "provider_refused",
    message: "The sandbox service refused the request: the sandbox account is not active.",
  });
  assert.doesNotMatch(JSON.stringify(read.body), /boat|again/i);
});

test("a request that is not a start-run request, or that ratel.yaml refuses, is 400 with the reason", async () => {
  const t = await setup();
  await t.push();
  const refused = async (body: unknown) => {
    const answer = await t.start(body);
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.equal(answer.body.error, "invalid");
    return answer.body.message as string;
  };
  assert.match(await refused({ input: 1 }), /name/);
  assert.match(await refused({ name: "support-agent" }), /input/);
  assert.match(await refused({ name: "support-agent", input: 1, params: { h: [1] } }), /params/);
  assert.equal(
    await refused({ name: "support-agent", input: 1, params: { tone: "dry" } }),
    "The param tone is not in ratel.yaml.",
  );
  assert.equal(
    await refused({ name: "support-agent", input: 1, tools: { mail: { mode: "live" } } }),
    "The tool mail is not in ratel.yaml.",
  );
});

test("an unknown name, version or run is 404; a version that is not ready is 409", async () => {
  const t = await setup();
  const notReady = await t.push(false);
  assert.equal((await t.start({ name: "nobody", input: 1 })).status, 404);
  assert.equal((await t.start({ name: "support-agent", input: 1 })).status, 404);
  assert.equal((await t.start({ versionId: "v_1", input: 1 })).status, 404);
  assert.equal((await t.start({ versionId: notReady, input: 1 })).status, 409);
  assert.equal((await t.get("nope")).status, 404);
  const versionId = await t.push();
  const started = await t.start({ versionId, input: 1 });
  assert.equal((await t.get(started.body.runId, { key: "other" })).status, 404);
});

test("a refusal over a limit is the flat api-error that names the limit", async () => {
  const t = await setup();
  await t.push();
  const answer = await t.start(
    { name: "support-agent", input: 1 },
    { limits: { sandbox_vm_starts_per_day: 0 } },
  );
  assert.equal(answer.status, 429);
  assert.deepEqual(Object.keys(answer.body).sort(), [
    "current",
    "error",
    "limit",
    "max",
    "message",
  ]);
  assert.equal(answer.body.error, "limit_reached");
  assert.equal(answer.body.limit, "sandbox_vm_starts_per_day");
});

test("the routes need their scope, and answer 404 with the flag off", async () => {
  const t = await setup();
  const versionId = await t.push();
  assert.equal(RUN, "sandboxes:run");
  assert.equal(READ, "sandboxes:read");
  assert.equal((await t.start({ versionId, input: 1 }, { key: "read" })).status, 403);
  assert.equal((await t.start({ versionId, input: 1 }, { key: "push" })).status, 403);
  const started = await t.start({ versionId, input: 1 });
  assert.equal((await t.get(started.body.runId, { key: "read" })).status, 200);
  assert.equal((await t.start({ versionId, input: 1 }, { on: false })).status, 404);
  assert.equal((await t.get(started.body.runId, { on: false })).status, 404);
  assert.equal((await t.start({ versionId, input: 1 }, { on: false, key: "bad" })).status, 404);
});

test("a run that an eval started keeps its captured text from a key without content:read or without the opt-in", async () => {
  const t = await setup();
  const versionId = await t.push();
  const started = await startRun(
    versionId,
    { message: "captured ask" },
    {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      requestedBy: `${EVAL_TRIAL_PREFIX}t-1`,
      params: { model: "large" },
    },
    t.runDeps(),
  );
  assert.ok(started.ok);
  await t.settle();
  const withheld = ["input", "output", "toolCalls", "logs", "params"];
  const noScope = await t.get(started.run.id, { key: "read" });
  assert.equal(noScope.status, 200);
  assert.ok(sandboxRunSchema.safeParse(noScope.body).success);
  assert.deepEqual(
    withheld.filter((field) => field in noScope.body),
    [],
  );
  assert.equal(noScope.body.contentWithheld, true);
  assert.equal(noScope.body.status, "completed");
  const optedOut = await t.get(started.run.id, { key: "full", optIn: false });
  assert.deepEqual(
    withheld.filter((field) => field in optedOut.body),
    [],
  );
  const allowed = await t.get(started.run.id, { key: "full", optIn: true });
  assert.deepEqual(allowed.body.input, { message: "captured ask" });
  assert.deepEqual(allowed.body.output, { reply: "refunded" });
  assert.deepEqual(allowed.body.params, { model: "large" });
  assert.equal(allowed.body.contentWithheld, undefined);
  // A run a key started itself (ratel run) keeps its output for that key.
  const own = await t.start({ versionId, input: { message: "mine" } }, { key: "runner" });
  await t.settle();
  const mine = await t.get(own.body.runId, { key: "runner", optIn: false });
  assert.deepEqual(mine.body.input, { message: "mine" });
  assert.deepEqual(mine.body.output, { reply: "refunded" });
});

test("a failed run that an eval started keeps its error text from a key without content:read", async () => {
  const t = await setup();
  const versionId = await t.push();
  scriptAgent(t.provider, { health: "never" });
  const started = await startRun(
    versionId,
    { message: "captured ask" },
    {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      requestedBy: `${EVAL_TRIAL_PREFIX}t-2`,
    },
    t.runDeps(),
  );
  assert.ok(started.ok);
  await t.settle();
  const allowed = await t.get(started.run.id, { key: "full", optIn: true });
  assert.equal(allowed.body.status, "failed");
  // The agent writes the error message, and can repeat its input there.
  const noScope = await t.get(started.run.id, { key: "read" });
  assert.ok(sandboxRunSchema.safeParse(noScope.body).success);
  assert.equal(noScope.body.contentWithheld, true);
  assert.equal(noScope.body.error.code, allowed.body.error.code);
  assert.notEqual(noScope.body.error.message, allowed.body.error.message);
  assert.equal(noScope.body.error.message, "The error text is withheld.");
});
