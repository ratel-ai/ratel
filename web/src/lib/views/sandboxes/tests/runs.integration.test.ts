import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { hashApiKey } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import { API_KEY_SCOPES } from "@/lib/platform/api-keys/scopes";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import type { RatelYaml } from "../domain/config";
import { runView, sandboxRunSchema, sandboxRunView } from "../domain/run";
import {
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderRefused,
  ProviderUnavailable,
  type SandboxProvider,
  type StartVmRequest,
  VM_START_TIMEOUT_MS,
} from "../ports/sandbox-provider";
import { START_STOPPED_MS, sweepRuns } from "../run-sweep";
import { withRunTokens } from "../run-token";
import { type RunDeps, type StartRunOptions, startRun } from "../runs";
import { type AgentScript, scriptAgent } from "./fake-agent";
import { createFakeProvider, type FakeVm } from "./fake-provider";
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

const KEY = Buffer.alloc(32, 3);
const SECRET = "secret-value-4411";
const IDLE_MS = 5 * 60_000;
const RESPONSE = {
  output: { reply: "refunded" },
  toolCalls: [
    { name: "lookup_order", args: { id: "7" }, mode: "live", result: { total: 3 } },
    {
      name: "refund_order",
      args: { id: "7" },
      mode: "recorded",
      error: { code: "no_fixture", message: "No fixture of refund_order." },
    },
  ],
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.002 },
};

type Setup = {
  config?: RatelYaml;
  agent?: AgentScript;
  limits?: Parameters<typeof createInMemoryUsageLimits>[0];
  callbackUrl?: string;
};

async function setup(over: Setup = {}) {
  const { db, client } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const secrets = createDrizzleSecretStore(db);
  const runs = createDrizzleRunStore(db);
  const vms = createDrizzleVmStore(db);
  const provider = createFakeProvider();
  const agent = scriptAgent(provider, {
    answer: { status: 200, body: JSON.stringify(RESPONSE) },
    ...over.agent,
  });
  const limits = createInMemoryUsageLimits(over.limits);
  const bundle = tarGz([{ name: "src/agent.ts", body: "x" }]);
  const created = await versions.create(
    {
      projectId: PROJECT_ID,
      apiKeyId: null,
      config: over.config ?? CONFIG,
      image: IMAGE,
      git: { commit: COMMIT, dirty: false },
      bundle: bundleInfo(bundle),
    },
    async () => ({ ok: true }),
  );
  assert.ok(created.ok);
  const versionId = created.version.id;
  for (const name of ["OPENAI_API_KEY", "NOT_DECLARED"]) {
    const sealed = sealSecret(KEY, { projectId: PROJECT_ID, name }, `${SECRET}-${name}`);
    await secrets.set(PROJECT_ID, name, sealed, "user_1");
  }
  const makeReady = async () => {
    const builds = createDrizzleBuildStore(db);
    await versions.markUploaded(PROJECT_ID, versionId);
    await builds.claim(PROJECT_ID, versionId, new Date());
    const imageRef = `rv-${versionId}`;
    provider.snapshots.set(imageRef, new Map());
    const smoke = { ok: true as const, output: 1, durationMs: 1, logs: "" };
    await builds.finish(versionId, { status: "ready", imageRef, smoke, log: "" }, new Date());
  };
  let clock = Date.now();
  const pending: Array<Promise<void>> = [];
  const deps: RunDeps = {
    runs,
    vms,
    versions,
    secrets,
    provider,
    limits,
    sealingKey: () => ({ ok: true, key: KEY }),
    callbackUrl: () => over.callbackUrl ?? "https://ratel.example",
    now: () => new Date(clock),
    background: (work) => {
      pending.push(work());
    },
  };
  const start = (
    more: Partial<RunDeps> = {},
    input: unknown = { message: "hi" },
    options: Partial<StartRunOptions> = {},
  ) =>
    startRun(
      versionId,
      input,
      {
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        requestedBy: "user_1",
        fixtures: [{ tool: "refund_order", arguments: { id: "7" }, result: 1 }],
        ...options,
      },
      { ...deps, ...more },
    );
  /** Waits for the work of the runs that started. */
  const settle = async () => {
    for (let work = pending.shift(); work; work = pending.shift()) await work;
  };
  const read = async (id: string) => {
    const run = await runs.get(PROJECT_ID, id);
    assert.ok(run);
    return run;
  };
  /** Starts a run and waits for its end. */
  const ran = async (more: Partial<RunDeps> = {}, options: Partial<StartRunOptions> = {}) => {
    const started = await start(more, { message: "hi" }, options);
    assert.ok(started.ok, JSON.stringify(started));
    await settle();
    return read(started.run.id);
  };
  const envOf = (vmRef: string, runId: string) =>
    Object.fromEntries(
      (provider.fileOf(vmRef, `/tmp/ratel-run-${runId}-env`) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ) as Record<string, string>;
  const sweep = (more: Partial<RunDeps> = {}) =>
    sweepRuns({
      ...deps,
      ...more,
      idleMs: IDLE_MS,
      organizationIdOf: async () => ORGANIZATION_ID,
    });
  const commands = () => provider.execs.map((exec) => exec.command);
  return {
    client,
    deps,
    secrets,
    runs,
    vms,
    provider,
    agent,
    limits,
    versionId,
    makeReady,
    start,
    ran,
    settle,
    read,
    envOf,
    sweep,
    commands,
    wait: (ms: number) => {
      clock += ms;
    },
  };
}

test("an HTTP run goes queued, running, completed, with the output, the tool calls, the usage and the logs", async () => {
  const t = await setup({ agent: { logs: "booted\n" } });
  await t.makeReady();
  const started = await t.start();
  assert.ok(started.ok);
  assert.equal(started.run.status, "queued");
  await t.settle();
  const run = await t.read(started.run.id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.response, RESPONSE);
  assert.equal(run.logs, "booted\n");
  assert.equal(run.errorCode, null);
  assert.equal(typeof run.durationMs, "number");
  assert.ok(run.startedAt && run.finishedAt);
  assert.equal(run.timeoutS, 120, "run.timeoutSeconds of ratel.yaml");
  assert.match(run.traceId ?? "", /^[0-9a-f]{32}$/);

  const [request] = t.agent.requests as Array<Record<string, unknown>>;
  assert.deepEqual(
    { ...request, traceparent: "?" },
    {
      v: 1,
      runId: run.id,
      input: { message: "hi" },
      params: { model: "small" },
      tools: { lookup_order: { mode: "live" }, refund_order: { mode: "simulated" } },
      fixtures: [{ tool: "refund_order", args: { id: "7" }, result: 1 }],
      traceparent: "?",
    },
  );
  assert.match(String(request?.traceparent), new RegExp(`^00-${run.traceId}-[0-9a-f]{16}-01$`));
  assert.equal(t.agent.made[0]?.name, `run-${run.id}`);
  assert.equal(t.agent.containers.size, 0, "the container is removed");

  const view = sandboxRunView(run);
  assert.ok(sandboxRunSchema.safeParse(view).success);
  assert.deepEqual(
    { status: view.status, output: view.output, toolCalls: view.toolCalls, usage: view.usage },
    { status: "completed", ...RESPONSE },
  );
  // What an eval scores.
  assert.equal(run.result?.status, "completed");
  assert.deepEqual(run.result?.output, { reply: "refunded" });
  assert.deepEqual(
    run.result?.toolCalls.map(({ name, source, error }) => [name, source, error ?? null]),
    [
      ["lookup_order", "real", null],
      ["refund_order", "fixture", "no_fixture: No fixture of refund_order."],
    ],
  );
  assert.equal(run.result?.traceId, run.traceId);
});

test("the run VM starts from the snapshot of the version, with inbound closed and outbound to the allowed domains only", async () => {
  const config = { ...CONFIG, network: { allow: ["api.openai.com"] } };
  const t = await setup({ config });
  await t.makeReady();
  const run = await t.ran();
  const [start] = t.provider.starts;
  assert.equal(start?.purpose, "run");
  assert.equal(start?.fromSnapshot, `rv-${t.versionId}`);
  assert.equal(start?.keepSnapshots, false);
  assert.deepEqual(start?.network, {
    inbound: "closed",
    // The agent sends its traces to Ratel.
    outbound: { mode: "allow", allow: ["api.openai.com", "ratel.example"] },
  });
  assert.deepEqual(start?.labels, {
    "ratel-project": PROJECT_ID,
    "ratel-version": t.versionId,
    "ratel-purpose": "run",
    "ratel-vm": run.vmId,
  });
  assert.equal(run.instanceRef, start?.vmRef);

  const local = await setup({ callbackUrl: "http://localhost:3000" });
  await local.makeReady();
  await local.ran();
  assert.deepEqual(local.provider.starts[0]?.network.outbound, { mode: "deny" });
});

test("the container gets the declared secrets, PORT, the secret names and the run token as its trace key, and no value is on a command line", async () => {
  const t = await setup({
    agent: {
      logs: `key ${SECRET}-OPENAI_API_KEY\n`,
      answer: { status: 200, body: JSON.stringify({ output: `echo ${SECRET}-OPENAI_API_KEY` }) },
    },
  });
  await t.makeReady();
  const run = await t.ran();
  const vmRef = run.instanceRef ?? "";
  const env = t.envOf(vmRef, run.id);
  assert.deepEqual(Object.keys(env).sort(), [
    "OPENAI_API_KEY",
    "PORT",
    "RATEL_API_KEY",
    "RATEL_BASE_URL",
    "RATEL_SECRET_NAMES",
  ]);
  assert.equal(env.OPENAI_API_KEY, `${SECRET}-OPENAI_API_KEY`);
  assert.equal(env.PORT, "8080");
  assert.equal(env.RATEL_SECRET_NAMES, "OPENAI_API_KEY");
  assert.equal(env.RATEL_BASE_URL, "https://ratel.example/api/v1");
  assert.match(env.RATEL_API_KEY ?? "", /^rtl_run_/);
  for (const command of t.commands()) {
    assert.doesNotMatch(command, new RegExp(SECRET));
    assert.ok(!command.includes(env.RATEL_API_KEY ?? "?"));
  }
  const files = [...(t.provider.vms.get(vmRef)?.files.keys() ?? [])];
  assert.deepEqual(files, [], "the env file and the request file are deleted");
  assert.equal(run.logs, "key [redacted]\n");
  assert.deepEqual(run.response?.output, "echo [redacted]");
  const { rows } = await t.client.query("select * from sandbox_runs");
  const stored = JSON.stringify(rows);
  assert.ok(!stored.includes(SECRET));
  assert.ok(!stored.includes(env.RATEL_API_KEY ?? "?"));
});

test("the run token only sends traces of its project, while the run is active", async () => {
  const t = await setup({ agent: { answer: "hang" } });
  await t.makeReady();
  const started = await t.start();
  assert.ok(started.ok);
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !t.agent.requests.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await t.read(started.run.id);
  assert.equal(run.status, "running");
  const token = t.envOf(run.instanceRef ?? "", run.id).RATEL_API_KEY ?? "";
  const noKey = async () => null;
  const lookup = withRunTokens(noKey, {
    offForAll: () => false,
    enabled: async () => true,
    runs: () => t.runs,
  });
  const ask = (scope: (typeof API_KEY_SCOPES)[number]) =>
    authenticateApiKey(`Bearer ${token}`, scope, {
      isDbConfigured: () => true,
      hashApiKey,
      findActiveApiKeyByHash: lookup,
    });
  for (const scope of API_KEY_SCOPES) {
    const allowed = await ask(scope);
    assert.equal(allowed.ok, scope === "ingest:traces", scope);
    if (allowed.ok) assert.equal(allowed.apiKey.projectId, PROJECT_ID);
  }
  await t.runs.finish(run.id, { status: "infra_error", errorCode: "x", message: "x" }, new Date());
  assert.equal((await ask("ingest:traces")).ok, false, "the run has ended");
});

const COMMAND_CONFIG: RatelYaml = {
  name: "cli-agent",
  run: { mode: "command", command: ["node", "agent.js"], timeoutSeconds: 30 },
  input: { example: "hello" },
};

test("command mode: the request goes on stdin, and stdout is the output", async () => {
  const t = await setup({
    config: COMMAND_CONFIG,
    agent: { command: { exitCode: 0, stdout: "hello back\n", stderr: "warming up\n" } },
  });
  await t.makeReady();
  const run = await t.ran();
  assert.equal(run.status, "completed");
  assert.deepEqual(run.response, { output: "hello back" });
  assert.equal(run.logs, "warming up\n");
  assert.equal((t.agent.requests[0] as { runId: string }).runId, run.id);
  assert.ok(t.commands().some((command) => command.includes(`timeout 30 docker start -ai run-`)));
  assert.equal(t.agent.containers.size, 0);
});

test("command mode: a non-zero exit is run_failed, with stderr as the logs", async () => {
  const t = await setup({
    config: COMMAND_CONFIG,
    agent: { command: { exitCode: 3, stderr: "TypeError: no input\n" } },
  });
  await t.makeReady();
  const run = await t.ran();
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "run_failed");
  assert.match(run.reason ?? "", /exited with code 3/);
  assert.equal(run.logs, "TypeError: no input\n");
  assert.equal(run.result?.error?.type, "run_failed");
});

const ERRORS: Array<[string, AgentScript, string, string, RegExp]> = [
  ["no health", { health: "never" }, "no_health", "failed", /did not answer 200 in 60 s/],
  ["a container that stops", { health: "stopped" }, "no_health", "failed", /stopped before/],
  ["nothing on the port", { health: "no_port" }, "no_port", "failed", /Nothing listens on \$PORT/],
  [
    "a body that is not JSON",
    { answer: { status: 200, body: "<h>" } },
    "not_json",
    "failed",
    /JSON/,
  ],
  [
    "no output",
    { answer: { status: 200, body: '{"reply":1}' } },
    "invalid_response",
    "failed",
    /not a run response: output/,
  ],
  [
    "a 500 that is not an error",
    { answer: { status: 500, body: "boom" } },
    "invalid_error",
    "failed",
    /answered 500/,
  ],
  [
    "an error of the agent",
    { answer: { status: 500, body: '{"error":{"code":"tool_failed","message":"No key."}}' } },
    "tool_failed",
    "failed",
    /^No key\.$/,
  ],
  ["a closed connection", { answer: { curlExit: 52 } }, "no_answer", "failed", /no answer/],
  ["a timeout", { answer: { curlExit: 28 } }, "timeout", "timed_out", /did not answer in 120 s/],
];

for (const [what, agent, code, status, message] of ERRORS) {
  test(`a run with ${what} ends ${status} with ${code}, a message and the logs`, async () => {
    const t = await setup({ agent: { ...agent, logs: "agent log\n" } });
    await t.makeReady();
    const run = await t.ran();
    assert.equal(run.status, status);
    assert.equal(run.errorCode, code);
    assert.match(run.reason ?? "", message);
    assert.equal(run.logs, "agent log\n");
    const view = sandboxRunView(run);
    assert.ok(sandboxRunSchema.safeParse(view).success);
    assert.equal(view.status, "failed");
    assert.deepEqual(view.error, { code, message: run.reason });
    assert.equal(t.agent.containers.size, 0, "the container is removed");
    assert.equal(t.provider.running.size, 1, "the VM stays warm");
  });
}

test("a rate limit, a full account or a broken service at the VM start fails the run with a reason to run again, with no provider name", async () => {
  const cases: Array<[Error, RegExp]> = [
    [new ProviderRateLimited("boat: 429 too many", 30), /again in 30 s/],
    [new ProviderAtCapacity("boat is full"), /as many machines as they can/],
    [new ProviderUnavailable("boat 503"), /did not answer/],
    [new Error("boat broke"), /did not work/],
  ];
  for (const [error, reason] of cases) {
    const t = await setup();
    await t.makeReady();
    const provider: SandboxProvider = {
      ...t.provider,
      startVm: async () => {
        throw error;
      },
    };
    const run = await t.ran({ provider });
    assert.equal(run.status, "infra_error");
    assert.equal(run.errorCode, "infra_error");
    assert.match(run.reason ?? "", reason);
    assert.doesNotMatch(run.reason ?? "", /boat/i);
    assert.equal(sandboxRunView(run).status, "failed");
    assert.deepEqual(t.limits.records, [], "no usage");
    assert.ok((await t.ran()).status === "completed", "the next run starts a new VM");
    assert.equal(t.provider.starts.length, 1);
  }
});

test("a refusal of the sandbox service fails the run with provider_refused, no provider name and no retry advice", async () => {
  const cases: Array<[number, string]> = [
    [402, "The sandbox service refused the request: the sandbox account is not active."],
    [403, "The sandbox service refused the request: the sandbox account lacks a permission."],
  ];
  for (const [status, reason] of cases) {
    const t = await setup();
    await t.makeReady();
    const provider: SandboxProvider = {
      ...t.provider,
      startVm: async () => {
        throw new ProviderRefused(`boat: refused (status ${status})`, status);
      },
    };
    const run = await t.ran({ provider });
    assert.equal(run.status, "infra_error");
    assert.equal(run.errorCode, "provider_refused");
    assert.equal(run.reason, reason);
    assert.deepEqual(sandboxRunView(run).error, { code: "provider_refused", message: reason });
    assert.equal(sandboxRunView(run).status, "failed");
    assert.deepEqual(t.limits.records, [], "no usage");
  }
});

test("a 404 or 409 refusal of the sandbox service (a VM that is gone) stays an infra failure, not provider_refused", async () => {
  for (const status of [404, 409]) {
    const t = await setup();
    await t.makeReady();
    const provider: SandboxProvider = {
      ...t.provider,
      exec: async () => {
        throw new ProviderRefused(`boat: the VM is not there (status ${status})`, status);
      },
    };
    const run = await t.ran({ provider });
    assert.equal(run.status, "infra_error");
    assert.equal(run.errorCode, "infra_error");
    assert.equal(run.reason, "The sandbox did not work. Run again.");
  }
});

test("a provider failure in the container deletes the VM and gives infra_error", async () => {
  const t = await setup();
  await t.makeReady();
  const provider: SandboxProvider = {
    ...t.provider,
    exec: async (vmRef, request) => {
      if (request.command.includes("/ratel/health")) throw new ProviderUnavailable();
      return t.provider.exec(vmRef, request);
    },
  };
  const run = await t.ran({ provider });
  assert.equal(run.status, "infra_error");
  assert.deepEqual(t.provider.deleted, [run.instanceRef]);
  const next = await t.ran();
  assert.equal(next.status, "completed");
  assert.notEqual(next.instanceRef, run.instanceRef, "a deleted VM takes no run");
});

test("runs of a version reuse its warm VM, each in a new container with its own name and host port", async () => {
  const t = await setup();
  await t.makeReady();
  const first = await t.ran();
  const [second, third] = await Promise.all([t.start(), t.start()]);
  assert.ok(second.ok && third.ok);
  await t.settle();
  assert.equal(t.provider.starts.length, 1);
  const runs = [first, await t.read(second.run.id), await t.read(third.run.id)];
  for (const run of runs) {
    assert.equal(run.status, "completed");
    assert.equal(run.instanceRef, first.instanceRef);
    assert.equal(run.vmId, first.vmId);
  }
  const names = t.agent.made.map(({ name }) => name);
  assert.deepEqual(names.sort(), runs.map(({ id }) => `run-${id}`).sort());
  assert.equal(new Set(t.agent.made.map(({ hostPort }) => hostPort)).size, 3);
  assert.equal(t.provider.running.size, 1);
  assert.deepEqual(t.limits.records.map(({ kind }) => kind).sort(), [
    "sandbox_run",
    "sandbox_run",
    "sandbox_run",
    "sandbox_vm_start",
  ]);
});

test("a VM start over the daily limit is refused with the limit name, and the run is not kept", async () => {
  const t = await setup({ limits: { sandbox_vm_starts_per_day: 1 } });
  await t.makeReady();
  await t.ran();
  t.wait(IDLE_MS + 1000);
  assert.equal((await t.sweep()).deletedVms, 1);
  const refused = await t.start();
  assert.ok(!refused.ok && refused.reason === "limit_reached");
  assert.deepEqual(
    [refused.limit, refused.max, refused.current],
    ["sandbox_vm_starts_per_day", 1, 1],
  );
  assert.match(refused.message, /sandbox_vm_starts_per_day/);
  assert.equal((await t.runs.list(PROJECT_ID, 10)).length, 1);
  assert.equal(t.provider.starts.length, 1);
});

test("the list of the page can leave out the runs of eval trials", async () => {
  const t = await setup();
  await t.makeReady();
  const mine = await t.start();
  const trial = await t.start({}, { message: "case" }, { requestedBy: "eval_trial:t1" });
  assert.ok(mine.ok && trial.ok);
  await t.settle();
  assert.equal((await t.runs.list(PROJECT_ID, 10)).length, 2);
  const manual = await t.runs.list(PROJECT_ID, 10, { excludeEvalTrials: true });
  assert.deepEqual(
    manual.map(({ id }) => id),
    [mine.run.id],
  );
});

test("a start over the concurrency limit is refused with the limit name", async () => {
  const t = await setup({ limits: { sandbox_concurrent_instances: 2 }, agent: { answer: "hang" } });
  await t.makeReady();
  assert.ok((await t.start()).ok);
  assert.ok((await t.start()).ok);
  const refused = await t.start();
  assert.ok(!refused.ok && refused.reason === "limit_reached");
  assert.deepEqual(
    [refused.limit, refused.max, refused.current],
    ["sandbox_concurrent_instances", 2, 2],
  );
});

test("two starts at the same time do not pass one free place", async () => {
  const t = await setup({ limits: { sandbox_concurrent_instances: 1 }, agent: { answer: "hang" } });
  await t.makeReady();
  const results = await Promise.all([t.start(), t.start(), t.start()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test("a start over the daily limit of runs is refused with the limit name", async () => {
  const t = await setup({ limits: { sandbox_runs_per_day: 1 } });
  await t.makeReady();
  await t.ran();
  const refused = await t.start();
  assert.ok(!refused.ok && refused.reason === "limit_reached");
  assert.equal(refused.limit, "sandbox_runs_per_day");
});

test("usage of a run is recorded one time, also after a failed record", async () => {
  const t = await setup();
  await t.makeReady();
  const broken = {
    ...t.limits,
    record: async () => {
      throw new Error("no answer");
    },
  };
  const run = await t.ran({ limits: broken });
  assert.equal(run.status, "completed");
  assert.equal(t.limits.records.length, 0);
  await t.sweep();
  await t.sweep();
  assert.deepEqual(
    t.limits.records.map(({ kind, reference }) => [kind, reference]),
    [["sandbox_run", run.id]],
  );
});

test("a run records its usage with the VM seconds of the run when it ends", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.ran();
  assert.equal(run.status, "completed");
  assert.equal(typeof run.durationMs, "number");
  const record = t.limits.records.find(({ kind }) => kind === "sandbox_run");
  assert.deepEqual(
    [record?.reference, record?.seconds],
    [run.id, Math.ceil((run.durationMs ?? 0) / 1000)],
  );
});

test("a run that the sweep ends records the seconds from its start to its end", async () => {
  const t = await setup({ agent: { answer: "hang" } });
  await t.makeReady();
  const started = await t.start();
  assert.ok(started.ok);
  for (let i = 0; i < 50 && !t.agent.requests.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await t.read(started.run.id);
  assert.equal(run.status, "running");
  assert.deepEqual(
    t.limits.records.filter(({ kind }) => kind === "sandbox_run"),
    [],
    "no record while the run is active",
  );
  t.wait(run.timeoutS * 1000 + 5 * 60_000);
  await t.sweep();
  await t.sweep();
  const ended = await t.read(run.id);
  assert.equal(ended.status, "timed_out");
  const seconds = ((ended.finishedAt?.getTime() ?? 0) - (ended.startedAt?.getTime() ?? 0)) / 1000;
  assert.deepEqual(
    t.limits.records
      .filter(({ kind }) => kind === "sandbox_run")
      .map(({ reference, seconds }) => [reference, seconds]),
    [[run.id, Math.ceil(seconds)]],
  );
  assert.ok(seconds >= run.timeoutS);
});

test("a start that cannot run is refused with the reason", async () => {
  const t = await setup();
  const reasonOf = async (more?: Partial<RunDeps>, input?: unknown) => {
    const result = await t.start(more, input);
    return result.ok ? "started" : result.reason;
  };
  assert.equal(await reasonOf(), "not_ready");
  await t.makeReady();
  assert.equal(await reasonOf({ provider: null }), "not_configured");
  const noKey = () => ({ ok: false as const, reason: "not_configured" as const, message: "No." });
  assert.equal(await reasonOf({ sealingKey: noKey }), "not_configured");
  assert.equal(
    await reasonOf({ sealingKey: () => ({ ok: true, key: Buffer.alloc(32, 9) }) }),
    "missing_secrets",
  );
  assert.equal(await reasonOf({}, "x".repeat(1024 * 1024 + 1)), "input_too_large");
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

test("a sandbox value wins over the project value, a value of another sandbox does not apply, and a missing name is refused with its name", async () => {
  const t = await setup();
  await t.makeReady();
  const setAt = async (sandboxName: string, value: string) => {
    const owner = { projectId: PROJECT_ID, name: "OPENAI_API_KEY", sandboxName };
    await t.secrets.set(PROJECT_ID, owner.name, sealSecret(KEY, owner, value), "u", sandboxName);
  };
  await setAt("other-agent", "other-sandbox-value");
  const atProject = await t.ran();
  assert.equal(
    t.envOf(atProject.instanceRef ?? "", atProject.id).OPENAI_API_KEY,
    `${SECRET}-OPENAI_API_KEY`,
  );
  await setAt(CONFIG.name, "sandbox-value");
  const atSandbox = await t.ran();
  assert.equal(t.envOf(atSandbox.instanceRef ?? "", atSandbox.id).OPENAI_API_KEY, "sandbox-value");
  await t.client.exec("delete from sandbox_secrets where sandbox_name is null");
  const onlySandbox = await t.ran();
  assert.equal(
    t.envOf(onlySandbox.instanceRef ?? "", onlySandbox.id).OPENAI_API_KEY,
    "sandbox-value",
  );
  await t.secrets.remove(PROJECT_ID, "OPENAI_API_KEY", CONFIG.name);
  const missing = await t.start();
  assert.ok(!missing.ok && missing.reason === "missing_secrets");
  assert.equal(missing.message, "Set these secrets first: OPENAI_API_KEY.");
});

test("a project value copied onto the sandbox level does not open", async () => {
  const t = await setup();
  await t.makeReady();
  const { rows } = await t.client.query<{ sealed_value: string }>(
    "select sealed_value from sandbox_secrets where name = 'OPENAI_API_KEY'",
  );
  await t.secrets.set(PROJECT_ID, "OPENAI_API_KEY", rows[0]?.sealed_value ?? "", "u", CONFIG.name);
  const moved = await t.start();
  assert.ok(!moved.ok && moved.reason === "missing_secrets");
  assert.match(moved.message, /OPENAI_API_KEY does not open/);
});

test("a strict start refuses params and tools that ratel.yaml does not declare, and names them", async () => {
  const t = await setup();
  await t.makeReady();
  const messageOf = async (options: Partial<StartRunOptions>) => {
    const result = await t.start({}, "hi", { strict: true, ...options });
    return result.ok ? "started" : `${result.reason}: ${result.message}`;
  };
  assert.equal(
    await messageOf({ params: { tone: "dry" } }),
    "invalid: The param tone is not in ratel.yaml.",
  );
  assert.equal(
    await messageOf({ params: { model: "huge" } }),
    "invalid: The param model must be one of: small, large.",
  );
  assert.equal(
    await messageOf({ tools: { send_mail: { mode: "live" } } }),
    "invalid: The tool send_mail is not in ratel.yaml.",
  );
  assert.equal(
    await messageOf({ params: { model: "large" }, tools: { lookup_order: { mode: "recorded" } } }),
    "started",
  );
  await t.settle();
  const request = t.agent.requests[0] as { params: object; tools: object };
  assert.deepEqual(request.params, { model: "large" });
  assert.deepEqual(request.tools, {
    lookup_order: { mode: "recorded" },
    refund_order: { mode: "simulated" },
  });
  // An eval also puts its earlier turns in the params.
  const loose = await t.start({}, "hi", { params: { earlierTurns: [{ text: "hi" }] } });
  assert.ok(loose.ok);
});

test("the sweep deletes a VM idle longer than the idle time, and not before", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.ran();
  t.wait(IDLE_MS - 1000);
  assert.equal((await t.sweep()).deletedVms, 0);
  t.wait(2000);
  assert.deepEqual(await t.sweep(), { endedRuns: 0, deletedVms: 1, sandboxRunErrors: 0 });
  assert.deepEqual(t.provider.deleted, [run.instanceRef]);
  assert.equal((await t.vms.get(run.vmId ?? ""))?.state, "deleted");
  await t.ran();
  assert.equal(t.provider.starts.length, 2, "a new run starts a new VM");
});

test("the idle sweep does not delete a VM that a run claims after the sweep read it", async () => {
  const t = await setup();
  await t.makeReady();
  const first = await t.ran();
  t.wait(IDLE_MS + 1000);
  let claimed: string | undefined;
  const vms = {
    ...t.vms,
    listIdle: async (...args: Parameters<typeof t.vms.listIdle>) => {
      const idle = await t.vms.listIdle(...args);
      const started = await t.start();
      assert.ok(started.ok);
      claimed = started.run.id;
      return idle;
    },
  };
  assert.equal((await t.sweep({ vms })).deletedVms, 0);
  assert.deepEqual(t.provider.deleted, []);
  await t.settle();
  const second = await t.read(claimed ?? "");
  assert.equal(second.status, "completed");
  assert.equal(second.vmId, first.vmId);
  assert.equal(t.provider.starts.length, 1);
});

test("the sweep ends a run past its timeout as timed_out and deletes its VM", async () => {
  const t = await setup({ agent: { answer: "hang" } });
  await t.makeReady();
  const started = await t.start();
  assert.ok(started.ok);
  for (let i = 0; i < 50 && !t.agent.requests.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await t.read(started.run.id);
  assert.equal(run.status, "running");
  t.wait(run.timeoutS * 1000);
  assert.equal((await t.sweep()).endedRuns, 0, "the run has some grace");
  t.wait(5 * 60_000);
  assert.deepEqual(await t.sweep(), { endedRuns: 1, deletedVms: 1, sandboxRunErrors: 0 });
  const ended = await t.read(run.id);
  assert.equal(ended.status, "timed_out");
  assert.equal(ended.errorCode, "timeout");
  assert.deepEqual(t.provider.deleted, [run.instanceRef]);
});

test("the sweep deletes a run VM that the database does not know, and no other VM", async () => {
  const t = await setup();
  await t.makeReady();
  const run = await t.ran();
  const network = { inbound: "closed", outbound: { mode: "deny" } } as const;
  const unknown = await t.provider.startVm({
    projectId: PROJECT_ID,
    purpose: "run",
    ttlS: 60,
    labels: { "ratel-run": "left by a crash" },
    network,
    keepSnapshots: false,
  });
  const prepare = await t.provider.startVm({
    projectId: PROJECT_ID,
    purpose: "prepare",
    ttlS: 60,
    labels: {},
    network,
    keepSnapshots: true,
  });
  assert.equal((await t.sweep()).deletedVms, 1);
  assert.deepEqual(t.provider.deleted, [unknown.vmRef]);
  assert.ok(t.provider.running.has(run.instanceRef ?? ""));
  assert.ok(t.provider.running.has(prepare.vmRef));
});

test("the sweep does not delete a run VM of another deployment on the same account", async () => {
  const t = await setup();
  const request: StartVmRequest = {
    projectId: PROJECT_ID,
    purpose: "run",
    ttlS: 60,
    labels: {},
    network: { inbound: "closed", outbound: { mode: "deny" } },
    keepSnapshots: false,
  };
  const foreign: FakeVm = {
    vmRef: "vm-of-staging",
    request,
    // The row of this VM is in the database of the other deployment.
    labels: { "ratel-purpose": "run", "ratel-vm": randomUUID(), "ratel-deployment": "staging" },
    state: "running",
    files: new Map(),
    createdAt: new Date(),
  };
  t.provider.vms.set(foreign.vmRef, foreign);
  assert.equal((await t.sweep()).deletedVms, 0);
  assert.deepEqual(t.provider.deleted, []);
});

test("a run whose process ended before the start is infra_error after a while", async () => {
  const t = await setup();
  await t.makeReady();
  const started = await t.start({ background: () => {} });
  assert.ok(started.ok);
  await t.sweep();
  assert.equal((await t.read(started.run.id)).status, "queued");
  t.wait(START_STOPPED_MS + 1000);
  assert.equal((await t.sweep()).endedRuns, 1);
  const run = await t.read(started.run.id);
  assert.equal(run.status, "infra_error");
  assert.match(run.reason ?? "", /did not start/);
});

test("the sweep leaves a VM start and its run alone while the start is in its time budget", async () => {
  const t = await setup();
  await t.makeReady();
  const started = await t.start({ background: () => {} });
  assert.ok(started.ok);
  t.wait(6 * 60_000);
  assert.deepEqual(await t.sweep(), { endedRuns: 0, deletedVms: 0, sandboxRunErrors: 0 });
  assert.equal((await t.read(started.run.id)).status, "queued");
  assert.equal((await t.vms.get(started.run.vmId ?? ""))?.state, "starting");
  t.wait(VM_START_TIMEOUT_MS);
  assert.equal((await t.sweep()).endedRuns, 1);
  assert.equal((await t.vms.get(started.run.vmId ?? ""))?.state, "deleted");
});

test("a run whose VM ends gives infra_error", async () => {
  const t = await setup({ agent: { answer: "hang" } });
  await t.makeReady();
  const started = await t.start();
  assert.ok(started.ok);
  for (let i = 0; i < 50 && !t.agent.requests.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await t.read(started.run.id);
  t.provider.exit(run.instanceRef ?? "");
  await t.sweep();
  assert.equal((await t.read(run.id)).status, "infra_error");
});

test("half of an emoji in the input does not lose the run", async () => {
  const t = await setup();
  await t.makeReady();
  const half = "\ud83d";
  const result = await t.start({}, { [half]: `cut ${half}` });
  assert.ok(result.ok);
  await t.settle();
  const run = await t.read(result.run.id);
  assert.equal(run.status, "completed");
  assert.deepEqual(runView(run).input, { "�": "cut �" });
});
