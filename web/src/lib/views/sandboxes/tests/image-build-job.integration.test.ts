import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { resolveConfig } from "@/config";
import { LONG_JOB_KINDS, SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { reapStaleRunningJobs, STALE_JOB_MS } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createLocalBundleStore } from "../adapters/local-bundle-store";
import { sandboxProvider, sandboxProviderConfigured } from "../adapters/provider-from-env";
import type { RatelYaml } from "../domain/config";
import { bundleKey, versionView } from "../domain/version";
import {
  BUILD_STOPPED_MS,
  HEARTBEAT_MS,
  type ImageBuildDeps,
  NOT_CONFIGURED_REASON,
  runImageBuild,
  STOPPED_REASON,
} from "../image-build-job";
import {
  ProviderAtCapacity,
  ProviderRateLimited,
  type SandboxProvider,
} from "../ports/sandbox-provider";
import { type AgentScript, scriptAgent } from "./fake-agent";
import { createFakeProvider } from "./fake-provider";
import { bundleInfo, COMMIT, CONFIG, createSandboxDb, IMAGE, PROJECT_ID, tarGz } from "./support";

const BUNDLE = tarGz([{ name: "manifest.json", body: "[]" }]);
const KEY = Buffer.alloc(32, 7);
const SECRET = "sk-live-secret-5521"; // gitleaks:allow (fake test value)
const ENV_FILE = "/tmp/ratel-smoke-env";
const REQUEST_FILE = "/tmp/ratel-smoke-request.json";
const IMAGE_FILE = "/home/user/image.tar";

type Setup = { stored?: Buffer; config?: RatelYaml; secrets?: string[]; agent?: AgentScript };

async function setup(over: Setup = {}) {
  const { db } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const builds = createDrizzleBuildStore(db);
  const secrets = createDrizzleSecretStore(db);
  const bundles = createLocalBundleStore(mkdtempSync(join(tmpdir(), "bundles-")));
  const created = await versions.create(
    {
      projectId: PROJECT_ID,
      apiKeyId: null,
      config: over.config ?? CONFIG,
      image: IMAGE,
      git: { commit: COMMIT, dirty: false },
      bundle: bundleInfo(BUNDLE),
    },
    async () => ({ ok: true }),
  );
  assert.ok(created.ok);
  const { version } = created;
  for (const name of over.secrets ?? ["OPENAI_API_KEY"]) {
    const sealed = sealSecret(KEY, { projectId: PROJECT_ID, name }, SECRET);
    await secrets.set(PROJECT_ID, name, sealed, "user_1");
  }
  const stored = over.stored ?? BUNDLE;
  await bundles.put(bundleKey(version), chunk(stored), bundleInfo(stored));
  await versions.markUploaded(PROJECT_ID, version.id);
  const provider = createFakeProvider();
  const agent = scriptAgent(provider, over.agent);
  const snapshotFiles: string[][] = [];
  const saveSnapshot = provider.saveSnapshot.bind(provider);
  provider.saveSnapshot = async (vmRef, name) => {
    snapshotFiles.push([...(provider.vms.get(vmRef)?.files.keys() ?? [])]);
    return saveSnapshot(vmRef, name);
  };
  const deps: ImageBuildDeps = {
    builds,
    bundles,
    provider,
    secrets,
    sealingKey: () => ({ ok: true, key: KEY }),
    now: () => new Date(),
    every: () => () => {},
  };
  const run = (more: Partial<ImageBuildDeps> = {}) =>
    runImageBuild(PROJECT_ID, { versionId: version.id }, { ...deps, ...more });
  const read = async () => {
    const found = await versions.get(PROJECT_ID, version.id);
    assert.ok(found);
    return found;
  };
  const commands = () => provider.execs.map((exec) => exec.command);
  return { db, deps, version, builds, provider, agent, snapshotFiles, run, read, commands };
}

test("a prepare goes preparing, then ready with the smoke result, a snapshot and a log", async () => {
  const t = await setup();
  let during = "";
  const provider: SandboxProvider = {
    ...t.provider,
    startVm: async (request) => {
      during = (await t.read()).status;
      return t.provider.startVm(request);
    },
  };
  assert.deepEqual(await t.run({ provider }), { status: "ready" });
  assert.equal(during, "preparing");
  const ready = await t.read();
  assert.equal(ready.status, "ready");
  assert.equal(ready.reason, null);
  assert.equal(ready.imageRef, `rv-${t.version.id}`);
  assert.ok(t.provider.snapshots.has(ready.imageRef ?? ""));
  assert.deepEqual(ready.config, CONFIG);
  assert.equal(ready.smoke?.ok, true);
  assert.deepEqual(ready.smoke?.ok && ready.smoke.output, { reply: "refunded" });
  assert.match(ready.buildLog ?? "", /Loaded image: agent:latest/);
  const view = versionView(ready);
  assert.deepEqual(view.smoke, ready.smoke);
  assert.equal(JSON.stringify(view).includes(ready.imageRef ?? "?"), false);

  const [start] = t.provider.starts;
  assert.equal(start?.purpose, "prepare");
  assert.equal(start?.keepSnapshots, true);
  assert.deepEqual(start?.network, { inbound: "open", outbound: { mode: "open" } });
  assert.deepEqual(start?.labels, {
    "ratel-project": PROJECT_ID,
    "ratel-version": t.version.id,
    "ratel-purpose": "prepare",
  });
  assert.deepEqual(
    t.provider.writes.map((write) => write.path),
    [IMAGE_FILE, ENV_FILE, REQUEST_FILE],
  );
  assert.deepEqual(t.provider.writes[0]?.body, BUNDLE);
  const request = JSON.parse(t.provider.writes[2]?.body.toString() ?? "");
  assert.deepEqual(
    { ...request, runId: "?" },
    {
      v: 1,
      runId: "?",
      input: { message: "Refund order 42" },
      params: { model: "small" },
      tools: { lookup_order: { mode: "simulated" }, refund_order: { mode: "simulated" } },
      fixtures: [],
    },
  );
  const tag = `ratel-agent:${t.version.id}`;
  const name = `smoke-${t.version.id}`;
  const commands = t.commands();
  assert.deepEqual(commands.slice(0, 3), [
    `docker load -i ${IMAGE_FILE}`,
    "docker image inspect --format '{{.Id}}' 'agent:latest'",
    `docker tag 'agent:latest' ${tag} && rm -f ${IMAGE_FILE}`,
  ]);
  assert.equal(
    commands[3],
    `docker run -d --name ${name} -p 127.0.0.1::8080 --env-file ${ENV_FILE} ${tag}; code=$?; rm -f ${ENV_FILE}; [ $code -eq 0 ] || exit $code; docker port ${name} 8080/tcp | head -n 1`,
  );
  assert.match(
    commands[4] ?? "",
    /curl -fsS -o \/dev\/null .*http:\/\/127\.0\.0\.1:32768\/ratel\/health/,
  );
  assert.match(
    commands[5] ?? "",
    /curl -sS --max-time 120 -X POST -H 'content-type: application\/json' --data-binary @\/tmp\/ratel-smoke-request\.json/,
  );
  assert.match(commands.at(-1) ?? "", /^docker ps -aq/);
  assert.deepEqual(t.provider.deleted, [start?.vmRef], "the prepare VM is deleted");
});

test("no secret value is on a command line, the env file is deleted, and the snapshot holds no smoke file", async () => {
  const t = await setup({ agent: { logs: `boot\nusing key ${SECRET}\nready\n` } });
  await t.run();
  const ready = await t.read();
  assert.equal(ready.status, "ready");
  for (const command of t.commands()) assert.doesNotMatch(command, new RegExp(SECRET));
  const vmRef = t.provider.starts[0]?.vmRef ?? "";
  assert.equal(
    t.provider.fileOf(vmRef, ENV_FILE),
    `OPENAI_API_KEY=${SECRET}\nPORT=8080\nRATEL_SECRET_NAMES=OPENAI_API_KEY\n`,
  );
  const [files] = t.snapshotFiles;
  assert.deepEqual(files, [], "no tarball, env file or request file in the snapshot");
  assert.equal(ready.smoke?.logs, "boot\nusing key [redacted]\nready\n");
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(SECRET));
  assert.equal(t.agent.containers.size, 0);
});

test("a missing secret fails the version before any VM starts", async () => {
  const t = await setup({ secrets: [] });
  assert.deepEqual(await t.run(), { status: "failed" });
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "Set these secrets first: OPENAI_API_KEY.");
  assert.equal(failed.smoke, null);
  assert.equal(t.provider.starts.length, 0);
});

const SMOKE_FAILURES: Array<[string, AgentScript, string, RegExp]> = [
  ["no health", { health: "never" }, "no_health", /GET \/ratel\/health did not answer 200 in 60 s/],
  ["a stopped container", { health: "stopped" }, "no_health", /stopped before/],
  ["a container that does not start", { starts: false }, "no_health", /did not start/],
  ["a body that is not JSON", { answer: { status: 200, body: "<html>" } }, "not_json", /not JSON/],
  [
    "JSON that is not a run response",
    { answer: { status: 200, body: '{"reply":1}' } },
    "invalid_response",
    /not a run response: output/,
  ],
  [
    "a 500 that is not an error",
    { answer: { status: 500, body: "boom" } },
    "invalid_error",
    /answered 500/,
  ],
  [
    "a 500 with an error",
    { answer: { status: 500, body: '{"error":{"code":"run_failed","message":"No model key."}}' } },
    "run_failed",
    /^No model key\.$/,
  ],
  ["a run over its timeout", { answer: { curlExit: 28 } }, "timeout", /did not answer in 120 s/],
];

for (const [what, agent, code, reason] of SMOKE_FAILURES) {
  test(`a smoke check with ${what} fails the version with ${code}, the logs, and no snapshot`, async () => {
    const t = await setup({ agent: { ...agent, logs: `the agent log ${SECRET}\n` } });
    assert.deepEqual(await t.run(), { status: "failed" });
    const failed = await t.read();
    assert.equal(failed.status, "failed");
    assert.match(failed.reason ?? "", reason);
    assert.equal(failed.smoke?.ok, false);
    assert.equal(!failed.smoke?.ok && failed.smoke?.error.code, code);
    assert.equal(!failed.smoke?.ok && failed.smoke?.error.message, failed.reason);
    assert.equal(failed.smoke?.logs, "the agent log [redacted]\n");
    assert.deepEqual(versionView(failed).smoke, failed.smoke);
    assert.equal(failed.imageRef, null);
    assert.equal(t.provider.snapshots.size, 0);
    assert.equal(t.provider.vms.size, 0, "the VM is deleted");
    assert.ok(t.commands().some((command) => command.startsWith(`docker rm -f smoke-`)));
    assert.equal(t.agent.containers.size, 0);
  });
}

const COMMAND_CONFIG: RatelYaml = {
  name: "cli-agent",
  run: { mode: "command", command: ["node", "agent.js", "--it's"], timeoutSeconds: 30 },
  input: { example: "hello" },
};

test("command mode: the request goes on stdin, and stdout text is the output", async () => {
  const t = await setup({
    config: COMMAND_CONFIG,
    secrets: [],
    agent: { command: { exitCode: 0, stdout: "hello back\n", stderr: "warming up\n" } },
  });
  assert.deepEqual(await t.run(), { status: "ready" });
  const ready = await t.read();
  assert.deepEqual(ready.smoke?.ok && ready.smoke.output, "hello back");
  assert.equal(ready.smoke?.logs, "warming up\n");
  const tag = `ratel-agent:${t.version.id}`;
  assert.ok(
    t
      .commands()
      .includes(
        `docker create -i --name smoke-${t.version.id} --env-file ${ENV_FILE} ${tag} 'node' 'agent.js' '--it'\\''s' >/dev/null; code=$?; rm -f ${ENV_FILE}; [ $code -eq 0 ] || exit $code; timeout 30 docker start -ai smoke-${t.version.id} < ${REQUEST_FILE}; code=$?; rm -f ${REQUEST_FILE}; exit $code`,
      ),
  );
  const vmRef = t.provider.starts[0]?.vmRef ?? "";
  assert.equal(t.provider.fileOf(vmRef, ENV_FILE), "PORT=8080\nRATEL_SECRET_NAMES=\n");
});

test("command mode: a non-zero exit fails the version with stderr as the logs", async () => {
  const t = await setup({
    config: COMMAND_CONFIG,
    secrets: [],
    agent: { command: { exitCode: 3, stderr: "TypeError: no input\n" } },
  });
  assert.deepEqual(await t.run(), { status: "failed" });
  const failed = await t.read();
  assert.equal(!failed.smoke?.ok && failed.smoke?.error.code, "run_failed");
  assert.match(failed.reason ?? "", /exited with code 3/);
  assert.equal(failed.smoke?.logs, "TypeError: no input\n");
  assert.equal(t.provider.snapshots.size, 0);
  assert.equal(t.provider.vms.size, 0);
});

test("command mode: a run over its timeout fails with timeout", async () => {
  const t = await setup({
    config: COMMAND_CONFIG,
    secrets: [],
    agent: { command: { exitCode: 124 } },
  });
  await t.run();
  const failed = await t.read();
  assert.equal(!failed.smoke?.ok && failed.smoke?.error.code, "timeout");
});

test("a container that stays after the smoke check stops the snapshot", async () => {
  const t = await setup({ agent: { keepsContainer: true } });
  assert.deepEqual(await t.run(), { status: "failed" });
  const failed = await t.read();
  assert.match(failed.reason ?? "", /no snapshot/i);
  assert.equal(t.provider.snapshots.size, 0);
  assert.equal(t.provider.vms.size, 0);
});

test("an image id other than the pushed digest is in the log", async () => {
  const t = await setup({ agent: { imageId: `sha256:${"d".repeat(64)}` } });
  await t.run();
  const ready = await t.read();
  assert.equal(ready.status, "ready");
  assert.match(
    ready.buildLog ?? "",
    new RegExp(`sha256:${"d".repeat(64)}.*sha256:${"c".repeat(64)}`),
  );
});

test("a second job for the same version prepares nothing", async () => {
  const t = await setup();
  await t.run();
  const { imageRef } = await t.read();
  assert.deepEqual(await t.run(), { status: "skipped" });
  assert.equal(t.provider.starts.length, 1);
  assert.equal((await t.read()).imageRef, imageRef);
});

test("a failed load gives failed with the end of its output, and the VM is deleted", async () => {
  const t = await setup();
  const scripted = t.provider.onExec;
  t.provider.onExec = (vm, request) =>
    request.command.startsWith("docker load")
      ? { exitCode: 1, stdout: "", stderr: "no luck: not a tarball\n", timedOut: false }
      : scripted(vm, request);
  await t.run();
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /loading the image failed with exit code 1\.\nno luck/);
  assert.match(failed.buildLog ?? "", /no luck/);
  assert.equal(failed.imageRef, null);
  assert.equal(failed.smoke, null);
  assert.equal(t.provider.vms.size, 0);
  assert.equal(t.provider.snapshots.size, 0);
});

test("a wrong tarball hash fails the build", async () => {
  const t = await setup({ stored: tarGz([{ name: "other", body: "y" }]) });
  await t.run();
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /checking the image failed/);
});

test("a provider error fails the build, and its text is not shown", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...t.provider,
    startVm: async () => {
      throw new Error("boat.dev refused account-123");
    },
  };
  await t.run({ provider });
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(`${failed.reason}${failed.buildLog}`, /boat|account-123/i);
});

test("a rate limit or a full account gives a reason to push again, with no provider name", async () => {
  const errors: Array<[Error, RegExp]> = [
    [new ProviderRateLimited("boat: 429", 30), /Push again in 30 s\./],
    [new ProviderRateLimited("boat: 429", null), /Push again in a minute\./],
    [new ProviderAtCapacity("boat: full"), /as many machines as it can/],
  ];
  for (const [error, reason] of errors) {
    const t = await setup();
    const provider: SandboxProvider = {
      ...t.provider,
      startVm: async () => {
        throw error;
      },
    };
    await t.run({ provider });
    const failed = await t.read();
    assert.match(failed.reason ?? "", reason);
    assert.doesNotMatch(failed.reason ?? "", /boat/i);
  }
});

test("a long log keeps its end", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...t.provider,
    exec: async (vmRef, request) => {
      const result = await t.provider.exec(vmRef, request);
      if (!request.command.startsWith("docker load")) return result;
      const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} \0 filler\n`);
      return { ...result, stdout: `${lines.join("")}${result.stdout}` };
    },
  };
  await t.run({ provider });
  const log = (await t.read()).buildLog ?? "";
  assert.ok(log.length < 70_000);
  assert.match(log, /^\[the start of the log is cut\]/);
  assert.match(log, /line 19999/);
  assert.equal((await t.read()).status, "ready");
});

test("with no provider the version stays unbuilt with the reason, and no call goes out", async () => {
  const t = await setup();
  const calls = mock.method(globalThis, "fetch", async () => {
    throw new Error("an outbound call");
  });
  const provider = sandboxProvider(resolveConfig());
  assert.equal(provider, null);
  assert.equal(sandboxProviderConfigured(resolveConfig()), false);
  assert.deepEqual(await t.run({ provider }), { status: "unbuilt" });
  const version = await t.read();
  assert.equal(version.status, "uploaded");
  assert.equal(version.reason, NOT_CONFIGURED_REASON);
  assert.match(NOT_CONFIGURED_REASON, /not configured/);
  assert.equal(calls.mock.callCount(), 0);
  mock.restoreAll();
});

test("a build of 12 minutes is not reaped, and a build with no heartbeat is", async () => {
  const t = await setup();
  const start = Date.now();
  let clock = start;
  const [job] = await t.db
    .insert(jobs)
    .values({
      projectId: PROJECT_ID,
      kind: SANDBOX_IMAGE_BUILD_JOB,
      status: "running",
      payload: { versionId: t.version.id },
      startedAt: new Date(start),
    })
    .returning();
  const reap = async () =>
    reapStaleRunningJobs(
      new Date(clock - STALE_JOB_MS),
      t.db,
      await t.builds.liveJobIds(new Date(clock - BUILD_STOPPED_MS)),
    );
  let beat = () => {};
  const provider: SandboxProvider = {
    ...t.provider,
    startVm: async (request) => {
      while (clock < start + 12 * 60_000) {
        clock += HEARTBEAT_MS;
        beat();
        await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(await reap(), 0, `reaped after ${(clock - start) / 60_000} minutes`);
        const since = new Date(clock - BUILD_STOPPED_MS);
        assert.equal(await t.builds.failStopped(since, STOPPED_REASON, new Date(clock)), 0);
      }
      return t.provider.startVm(request);
    },
  };
  const result = await t.run({
    provider,
    now: () => new Date(clock),
    every: (_ms, work) => {
      beat = work;
      return () => {};
    },
  });
  assert.deepEqual(result, { status: "ready" });

  // The process of another build ends: no heartbeat any more.
  await t.db.execute("update sandbox_versions set status = 'preparing'");
  clock += BUILD_STOPPED_MS + 60_000;
  assert.equal(await reap(), 1);
  const [reaped] = await t.db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(reaped.status, "error");
  const since = new Date(clock - BUILD_STOPPED_MS);
  assert.equal(await t.builds.failStopped(since, STOPPED_REASON, new Date(clock)), 1);
  assert.equal((await t.read()).status, "failed");
});

test("an uploaded version with no job is found, one time", async () => {
  const t = await setup();
  const later = new Date(Date.now() + 60_000);
  const expected = [{ projectId: PROJECT_ID, versionId: t.version.id }];
  assert.deepEqual(await t.builds.listUnqueued(new Date(0)), []);
  assert.deepEqual(await t.builds.listUnqueued(later), expected);
  await t.db.insert(jobs).values({
    projectId: PROJECT_ID,
    kind: SANDBOX_IMAGE_BUILD_JOB,
    payload: { versionId: t.version.id },
  });
  assert.deepEqual(await t.builds.listUnqueued(later), []);
});

test("a build that the provider never answers fails at its deadline", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...createFakeProvider(),
    startVm: () => new Promise(() => {}),
  };
  const result = await t.run({ provider, deadlineMs: 20 });
  assert.deepEqual(result, { status: "failed" });
  assert.equal((await t.read()).reason, "The build took too long. Push again.");
});

test("a build runs in the lane of long jobs", () => {
  assert.ok((LONG_JOB_KINDS as readonly string[]).includes(SANDBOX_IMAGE_BUILD_JOB));
});

async function* chunk(body: Buffer) {
  yield body;
}

test("the tarball opens after the VM starts, and closes when the write breaks", async () => {
  const t = await setup();
  const body = Readable.from([BUNDLE, BUNDLE]);
  let opened = 0;
  const bundles = {
    ...t.deps.bundles,
    open: async () => {
      opened += 1;
      return body;
    },
  };
  const before: number[] = [];
  const provider: SandboxProvider = {
    ...t.provider,
    async startVm(request) {
      before.push(opened);
      return t.provider.startVm(request);
    },
    async writeFile(_vmRef, request) {
      if (request.body instanceof Uint8Array) return;
      for await (const _ of request.body) throw new Error("lost");
    },
  };
  assert.deepEqual(await t.run({ bundles, provider }), { status: "failed" });
  assert.deepEqual(before, [0]);
  assert.equal(body.destroyed, true);
  assert.equal(t.provider.vms.size, 0);
});
