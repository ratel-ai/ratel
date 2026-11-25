import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { hashApiKey } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import { API_KEY_SCOPES } from "@/lib/platform/api-keys/scopes";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { type RunInput, runView } from "../domain/run";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { handleRunResult, type ResultApiDeps } from "../result-api";
import { START_STOPPED_MS, sweepRuns } from "../run-sweep";
import { withRunTokens } from "../run-token";
import { type RunDeps, startRun } from "../runs";
import { createFakeProvider } from "./fake-provider";
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

const KEY = Buffer.alloc(32, 3);
const SECRET = "secret-value-4411";
const TRACE_ID = "c".repeat(32);

async function setup(limitOverrides: Parameters<typeof createInMemoryUsageLimits>[0] = {}) {
  const { db, client } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const secrets = createDrizzleSecretStore(db);
  const runs = createDrizzleRunStore(db);
  const provider = createFakeProvider();
  const limits = createInMemoryUsageLimits(limitOverrides);
  const bundle = tarGz([{ name: "src/agent.ts", body: "x" }]);
  const created = await versions.create(
    {
      projectId: PROJECT_ID,
      apiKeyId: null,
      manifest: MANIFEST,
      git: { commit: COMMIT, dirty: false },
      bundle: bundleInfo(bundle),
    },
    async () => ({ ok: true }),
  );
  assert.ok(created.ok);
  const versionId = created.version.id;
  const setSecret = (name: string) =>
    secrets.set(
      PROJECT_ID,
      name,
      sealSecret(KEY, { projectId: PROJECT_ID, name }, `${SECRET}-${name}`),
      "user_1",
    );
  await setSecret("OPENAI_API_KEY");
  await setSecret("NOT_DECLARED");
  const makeReady = async () => {
    const builds = createDrizzleBuildStore(db);
    await versions.markUploaded(PROJECT_ID, versionId);
    await builds.claim(PROJECT_ID, versionId, new Date());
    const { imageRef } = await provider.buildImage({
      versionId,
      projectId: PROJECT_ID,
      base: MANIFEST.base,
      install: [],
      entry: MANIFEST.entry,
      bundle: {
        ...bundleInfo(bundle),
        body: (async function* () {
          yield bundle;
        })(),
      },
      log: () => {},
    });
    await builds.finish(versionId, { status: "ready", imageRef, log: "" }, new Date());
  };
  let clock = Date.now();
  const deps: RunDeps = {
    runs,
    versions,
    secrets,
    provider,
    limits,
    sealingKey: () => ({ ok: true, key: KEY }),
    callbackUrl: () => "https://ratel.example",
    now: () => new Date(clock),
  };
  const start = (over: Partial<RunDeps> = {}, input: unknown = { message: "hi" }) =>
    startRun(
      versionId,
      input,
      {
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        requestedBy: "user_1",
        fixtures: [{ tool: "refund_order", arguments: { id: "7" }, result: 1 }],
      },
      { ...deps, ...over },
    );
  const started = async (over?: Partial<RunDeps>) => {
    const result = await start(over);
    assert.ok(result.ok);
    return result.run;
  };
  const envOf = (index = 0) => provider.starts[index]?.env ?? {};
  const resultDeps: ResultApiDeps = {
    ...deps,
    offForAll: () => false,
    enabled: async () => true,
    afterResponse: (work) => {
      pending.push(work());
    },
  };
  const pending: Array<Promise<void>> = [];
  const post = async (
    runId: string,
    token: string,
    body: unknown = resultBody(runId),
    over: Partial<ResultApiDeps> = {},
  ) => {
    const response = await handleRunResult(
      new Request("http://x", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      runId,
      { ...resultDeps, ...over },
    );
    await Promise.all(pending);
    return response.status;
  };
  const sweep = () => sweepRuns({ ...deps, organizationIdOf: async () => ORGANIZATION_ID });
  const read = async (id: string) => {
    const run = await runs.get(PROJECT_ID, id);
    assert.ok(run);
    return run;
  };
  const wait = (ms: number) => {
    clock += ms;
  };
  return {
    client,
    deps,
    runs,
    provider,
    limits,
    versionId,
    makeReady,
    start,
    started,
    envOf,
    post,
    sweep,
    read,
    wait,
  };
}

function resultBody(runId: string) {
  return {
    v: 1,
    runId,
    status: "completed",
    output: "done \0",
    toolCalls: [{ name: "refund_order", arguments: { id: "7" }, result: 1, source: "fixture" }],
    usage: { durationMs: 12 },
    traceId: TRACE_ID,
  };
}

test("a run goes queued, running, completed, and stores the output and the tool calls", async () => {
  const t = await setup();
  await t.makeReady();
  let during = "";
  const provider: SandboxProvider = {
    ...t.provider,
    startInstance: async (request) => {
      during = (await t.read(request.runId)).status;
      return t.provider.startInstance(request);
    },
  };
  const run = await t.started({ provider });
  assert.equal(during, "queued");
  assert.equal(run.status, "running");
  assert.equal(await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? ""), 202);
  const done = await t.read(run.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result?.output, "done ");
  assert.equal(done.result?.toolCalls[0]?.source, "fixture");
  assert.equal(done.traceId, TRACE_ID);
  assert.ok(done.finishedAt);
});

test("the instance gets the input, the address, a token and only the declared secrets", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  const env = t.envOf();
  assert.equal(env.OPENAI_API_KEY, `${SECRET}-OPENAI_API_KEY`);
  assert.equal(env.NOT_DECLARED, undefined);
  assert.equal(env.RATEL_URL, "https://ratel.example");
  assert.equal(env.RATEL_SECRET_NAMES, "OPENAI_API_KEY");
  const input = JSON.parse(
    gunzipSync(Buffer.from(env.RATEL_RUN_INPUT ?? "", "base64")).toString(),
  ) as RunInput;
  assert.equal(input.runId, run.id);
  assert.deepEqual(input.input, { message: "hi" });
  assert.deepEqual(input.toolPolicy, { sideEffects: "fake" });
  assert.equal(input.fixtures.length, 1);
  const { rows } = await t.client.query("select * from sandbox_runs");
  const stored = JSON.stringify(rows) + JSON.stringify(runView(await t.read(run.id)));
  assert.ok(!stored.includes(env.RATEL_RUN_TOKEN ?? "?"));
  assert.ok(!stored.includes(SECRET));
});

test("each run starts a new instance, and the instance is stopped after the result", async () => {
  const t = await setup();
  await t.makeReady();
  const first = await t.started();
  const second = await t.started();
  assert.notEqual(first.instanceRef, second.instanceRef);
  assert.equal(t.provider.starts.length, 2);
  await t.post(first.id, t.envOf(0).RATEL_RUN_TOKEN ?? "");
  assert.deepEqual(t.provider.stops, [first.instanceRef]);
  await t.post(second.id, t.envOf(1).RATEL_RUN_TOKEN ?? "");
  assert.deepEqual(t.provider.stops, [first.instanceRef, second.instanceRef]);
  assert.equal(t.provider.running.size, 0);
  assert.ok((await t.read(second.id)).instanceStoppedAt);
  assert.deepEqual(await t.sweep(), { endedRuns: 0, stoppedInstances: 0, sandboxRunErrors: 0 });
  assert.deepEqual(await t.runs.listOpen(10), [], "nothing is left to do");
});

test("an agent failure is failed", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  const { output: _output, ...body } = resultBody(run.id);
  const failed = { ...body, status: "failed", error: { type: "TypeError", message: "boom" } };
  assert.equal(await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? "", failed), 202);
  assert.equal((await t.read(run.id)).status, "failed");
});

test("a run with no result after the timeout is timed_out and its instance is stopped", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  assert.equal(run.timeoutS, 1800);
  assert.equal(t.provider.starts[0]?.timeoutS, 1860);
  t.wait(29 * 60_000);
  assert.equal((await t.sweep()).endedRuns, 0);
  t.wait(60_000);
  assert.deepEqual(await t.sweep(), { endedRuns: 1, stoppedInstances: 1, sandboxRunErrors: 0 });
  assert.equal((await t.read(run.id)).status, "timed_out");
  assert.deepEqual(t.provider.stops, [run.instanceRef]);
  assert.equal(t.provider.running.size, 0);
  assert.equal(await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? ""), 401, "too late");
});

test("an instance that ends with no result gives infra_error", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  t.provider.exit(run.instanceRef ?? "", 1);
  await t.sweep();
  assert.equal((await t.read(run.id)).status, "infra_error");
});

test("a provider error at start gives infra_error, not failed, and records no usage", async () => {
  const t = await setup();
  await t.makeReady();
  const provider: SandboxProvider = {
    ...t.provider,
    startInstance: async () => {
      throw new Error("modal said no");
    },
  };
  const result = await t.start({ provider });
  assert.ok(result.ok);
  assert.equal(result.run.status, "infra_error");
  assert.doesNotMatch(result.run.reason ?? "", /modal/i);
  assert.deepEqual(t.limits.records, []);
});

test("a run whose process ended before the start is infra_error after two minutes", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  await t.client.exec(
    "update sandbox_runs set status = 'queued', instance_ref = null, started_at = null",
  );
  await t.sweep();
  assert.equal((await t.read(run.id)).status, "queued");
  t.wait(START_STOPPED_MS + 1000);
  await t.sweep();
  assert.equal((await t.read(run.id)).status, "infra_error");
});

test("an instance that did not stop is stopped by the next sweep", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  const broken: SandboxProvider = {
    ...t.provider,
    stopInstance: async () => {
      throw new Error("no answer");
    },
  };
  await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? "", undefined, { provider: broken });
  assert.equal((await t.read(run.id)).status, "completed");
  assert.equal(t.provider.running.size, 1);
  assert.equal((await t.sweep()).stoppedInstances, 1);
  assert.equal(t.provider.running.size, 0);
});

test("a result that comes before the start returns still stops the instance", async () => {
  const t = await setup();
  await t.makeReady();
  const provider: SandboxProvider = {
    ...t.provider,
    startInstance: async (request) => {
      const instance = await t.provider.startInstance(request);
      await t.post(request.runId, request.env.RATEL_RUN_TOKEN ?? "");
      return instance;
    },
  };
  const run = await t.started({ provider });
  assert.equal(run.status, "completed");
  assert.equal(t.provider.running.size, 0);
});

test("the run token cannot post a result for another run", async () => {
  const t = await setup();
  await t.makeReady();
  const first = await t.started();
  const second = await t.started();
  const token = t.envOf(0).RATEL_RUN_TOKEN ?? "";
  assert.equal(await t.post(second.id, token), 403);
  assert.equal(await t.post(first.id, token, resultBody(second.id)), 400);
  assert.equal((await t.read(second.id)).status, "running");
  assert.equal(await t.post(first.id, "rtl_run_other"), 401);
  assert.equal(await t.post(first.id, token), 202);
  assert.equal(await t.post(first.id, token), 401, "a token works for one result");
  assert.equal(t.provider.stops.length, 1);
});

test("the run token reads no API: only trace ingest of its project knows it, while the run lives", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  const token = t.envOf().RATEL_RUN_TOKEN ?? "";
  const noKey = async () => null;
  const traceLookup = withRunTokens(noKey, {
    offForAll: () => false,
    enabled: async () => true,
    runs: () => t.runs,
  });
  const ask = (scope: (typeof API_KEY_SCOPES)[number], find: Parameters<typeof withRunTokens>[0]) =>
    authenticateApiKey(`Bearer ${token}`, scope, {
      isDbConfigured: () => true,
      hashApiKey,
      findActiveApiKeyByHash: find,
    });
  // Every other route uses the plain lookup.
  for (const scope of API_KEY_SCOPES) assert.equal((await ask(scope, noKey)).ok, false, scope);
  for (const scope of API_KEY_SCOPES) {
    const allowed = await ask(scope, traceLookup);
    assert.equal(allowed.ok, scope === "ingest:traces", scope);
    if (allowed.ok) {
      assert.equal(allowed.apiKey.projectId, PROJECT_ID);
      assert.equal(allowed.policy.appendOnlyIngest, true);
    }
  }
  const off = withRunTokens(noKey, {
    offForAll: () => false,
    enabled: async () => false,
    runs: () => t.runs,
  });
  assert.equal((await ask("ingest:traces", off)).ok, false, "the flag is off");
  await t.post(run.id, token);
  assert.equal((await ask("ingest:traces", traceLookup)).ok, false, "the run has ended");
});

test("a start over the concurrency limit is refused with the limit name", async () => {
  const t = await setup({ sandbox_concurrent_instances: 2 });
  await t.makeReady();
  const first = await t.started();
  await t.started();
  const refused = await t.start();
  assert.ok(!refused.ok && refused.reason === "limit_reached");
  assert.deepEqual(
    [refused.limit, refused.max, refused.current],
    ["sandbox_concurrent_instances", 2, 2],
  );
  assert.equal(t.provider.starts.length, 2);
  await t.post(first.id, t.envOf(0).RATEL_RUN_TOKEN ?? "");
  assert.ok((await t.start()).ok, "a stopped instance frees its place");
});

test("two starts at the same time do not pass one free place", async () => {
  const t = await setup({ sandbox_concurrent_instances: 1 });
  await t.makeReady();
  const results = await Promise.all([t.start(), t.start(), t.start()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test("a start over the daily limit is refused with the limit name", async () => {
  const t = await setup({ sandbox_runs_per_day: 1 });
  await t.makeReady();
  const run = await t.started();
  await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? "");
  const refused = await t.start();
  assert.ok(!refused.ok && refused.reason === "limit_reached");
  assert.equal(refused.limit, "sandbox_runs_per_day");
});

test("usage is recorded one time for each started run, also after a failed record", async () => {
  const t = await setup();
  await t.makeReady();
  const broken = {
    ...t.limits,
    record: async () => {
      throw new Error("no answer");
    },
  };
  const run = await t.started({ limits: broken });
  assert.equal(run.status, "running");
  assert.equal(t.limits.records.length, 0);
  await t.sweep();
  await t.sweep();
  assert.deepEqual(t.limits.records, [
    {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      kind: "sandbox_run",
      reference: run.id,
      amount: 1,
    },
  ]);
});

test("a start that cannot run is refused with the reason", async () => {
  const t = await setup();
  const reasonOf = async (over?: Partial<RunDeps>, input?: unknown) => {
    const result = await t.start(over, input);
    return result.ok ? "started" : result.reason;
  };
  assert.equal(await reasonOf(), "not_ready");
  await t.makeReady();
  assert.equal(await reasonOf({ provider: null }), "not_configured");
  const noKey = () => ({
    ok: false as const,
    reason: "not_configured" as const,
    message: "No key.",
  });
  assert.equal(await reasonOf({ sealingKey: noKey }), "not_configured");
  assert.equal(
    await reasonOf({ sealingKey: () => ({ ok: true, key: Buffer.alloc(32, 9) }) }),
    "missing_secrets",
  );
  const large = Array.from({ length: 200_000 }, (_, i) => Math.sin(i));
  assert.equal(await reasonOf({}, large), "input_too_large");
  const other = await startRun(
    t.versionId,
    {},
    { projectId: OTHER_PROJECT_ID, organizationId: ORGANIZATION_ID, requestedBy: "u" },
    t.deps,
  );
  assert.ok(!other.ok && other.reason === "not_found");
  await t.client.exec("delete from sandbox_secrets");
  const missing = await t.start();
  assert.ok(!missing.ok && missing.reason === "missing_secrets");
  assert.match(missing.message, /OPENAI_API_KEY/);
  assert.equal(t.provider.starts.length, 0);
});

test("the result route is 404 with the flag off, and refuses what is not a result", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.started();
  const token = t.envOf().RATEL_RUN_TOKEN ?? "";
  assert.equal(await t.post(run.id, token, undefined, { offForAll: () => true }), 404);
  assert.equal(await t.post(run.id, token, undefined, { enabled: async () => false }), 404);
  assert.equal(await t.post(run.id, token, { v: 1 }), 400);
  const large = { ...resultBody(run.id), output: "x".repeat(6 * 1024 * 1024) };
  assert.equal(await t.post(run.id, token, large), 413);
  assert.equal((await t.read(run.id)).status, "running");
});

test("half of an emoji in the input or the output does not lose the run", async () => {
  const t = await setup();
  await t.makeReady();
  const half = "\ud83d";
  const result = await t.start({}, { [half]: `cut ${half}` });
  assert.ok(result.ok);
  const body = { ...resultBody(result.run.id), output: { [half]: `cut ${half}` } };
  // What an agent sends: JSON.stringify writes the half as an escape.
  assert.equal(await t.post(result.run.id, t.envOf().RATEL_RUN_TOKEN ?? "", body), 202);
  assert.deepEqual((await t.read(result.run.id)).result?.output, { "�": "cut �" });
});

test("an instance whose start is not stored is stopped", async () => {
  const t = await setup();
  await t.makeReady();
  const runs = {
    ...t.runs,
    markStarted: async () => {
      throw new Error("database lost");
    },
  };
  await assert.rejects(t.start({ runs }), /database lost/);
  assert.equal(t.provider.starts.length, 1);
  assert.equal(t.provider.stops.length, 1);
  assert.equal(t.provider.running.size, 0);
});

test("a run token reads as a key that was used", async () => {
  const t = await setup();
  await t.makeReady();
  await t.started();
  const find = withRunTokens(async () => null, {
    offForAll: () => false,
    enabled: async () => true,
    runs: () => t.runs,
  });
  const key = await find(hashApiKey(t.envOf().RATEL_RUN_TOKEN ?? ""));
  assert.ok(key?.lastUsedAt, "each run would count as the first trace of a key");
});

test("the instances of a deleted project are stopped by the sweep", async () => {
  const t = await setup();
  await t.makeReady();
  await t.started();
  await t.started();
  assert.equal(t.provider.running.size, 2);
  await t.client.exec(`delete from projects where id = '${PROJECT_ID}'`);

  const broken: SandboxProvider = {
    ...t.provider,
    stopInstance: async () => {
      throw new Error("no answer");
    },
  };
  await sweepRuns({ ...t.deps, provider: broken, organizationIdOf: async () => null });
  assert.equal(t.provider.running.size, 2);
  assert.equal((await t.sweep()).stoppedInstances, 2);
  assert.equal(t.provider.running.size, 0);
  assert.equal((await t.sweep()).stoppedInstances, 0);
});

test("an instance that starts after the delete of its project is stopped", async () => {
  const t = await setup();
  await t.makeReady();
  let deleted = false;
  const provider: SandboxProvider = {
    ...t.provider,
    startInstance: async (request) => {
      const made = await t.provider.startInstance(request);
      await t.client.exec(`delete from projects where id = '${PROJECT_ID}'`);
      deleted = true;
      return made;
    },
    stopInstance: async () => {
      throw new Error("no answer");
    },
  };
  await t.start({ provider });
  assert.ok(deleted);
  await t.sweep();
  assert.equal(t.provider.running.size, 0);
});

test("active runs of other projects do not hide an ended run from the sweep", async () => {
  const t = await setup();
  await t.makeReady();
  await t.client.exec(`
    insert into sandbox_runs (project_id, version_id, run_input, status, token_hash, timeout_s, requested_by, created_at, started_at, instance_ref)
    select '${OTHER_PROJECT_ID}', '${t.versionId}', '{}', 'running', 'hash-' || n, 100000, 'user_1', now() - interval '1 hour', now(), 'busy-' || n
    from generate_series(1, 500) n`);
  const run = await t.started();
  const broken = async () => {
    throw new Error("no answer");
  };
  const provider = { ...t.provider, stopInstance: broken };
  await t.post(run.id, t.envOf().RATEL_RUN_TOKEN ?? "", undefined, { provider });
  assert.equal(t.provider.running.size, 1);
  const busy = { ...t.provider, status: async () => ({ state: "running" as const }) };
  await sweepRuns({ ...t.deps, provider: busy, organizationIdOf: async () => ORGANIZATION_ID });
  assert.equal(t.provider.running.size, 0);
});
