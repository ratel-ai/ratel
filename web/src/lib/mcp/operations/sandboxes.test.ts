import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { assembleOperations } from "@/lib/mcp/operations";
import { buildRegistry } from "@/lib/mcp/registry";
import type { SandboxRun, SandboxVersionDetail, StartRunOptions } from "@/lib/views/sandboxes";
import { type SandboxOperationDeps, sandboxOperations } from "./sandboxes";

/**
 * The sandbox tools, through dispatch with fake module calls. They pin what an agent needs to call
 * a version without a second guess: the flag, the project, the declared params, and a run result
 * that shows the input and the output first.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const T0 = new Date("2026-11-26T10:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function version(overrides: Partial<SandboxVersionDetail> = {}): SandboxVersionDetail {
  return {
    id: VERSION,
    projectId: PROJECT,
    sandboxId: "sbx-1",
    name: "support-agent",
    git: { commit: "a".repeat(40), dirty: false },
    status: "ready",
    reason: null,
    config: {
      name: "support-agent",
      input: { example: { message: "Where is my order?" } },
      params: {
        tone: { type: "enum", options: ["formal", "casual"], default: "formal" },
        maxSteps: { type: "number", description: "The most tool calls of one turn." },
      },
      tools: { lookup_order: { mode: "simulated" }, refund: {} },
    },
    smoke: {
      ok: true,
      output: { reply: "Your order ships today." },
      durationMs: 812,
      logs: "smoke ok",
    },
    createdAt: T0,
    ...overrides,
  };
}

function run(overrides: Partial<SandboxRun> = {}): SandboxRun {
  return {
    id: RUN,
    projectId: PROJECT,
    versionId: VERSION,
    request: {
      v: 1,
      runId: RUN,
      input: { message: "Where is my order?" },
      params: { tone: "formal" },
      tools: { lookup_order: { mode: "simulated" } },
      fixtures: [],
    },
    status: "completed",
    response: null,
    errorCode: null,
    reason: null,
    logs: "started\nanswered",
    durationMs: 1200,
    result: {
      v: 1,
      runId: RUN,
      status: "completed",
      output: { reply: "It ships today." },
      toolCalls: [
        {
          name: "lookup_order",
          arguments: { id: "A1" },
          result: { status: "shipped" },
          source: "fake",
        },
      ],
      usage: { durationMs: 1200 },
      traceId: "t".repeat(32),
    },
    traceId: "t".repeat(32),
    vmId: "vm-1",
    instanceRef: "inst-1",
    timeoutS: 300,
    requestedBy: "mcp:key-1",
    createdAt: T0,
    startedAt: T0,
    finishedAt: T0,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<SandboxOperationDeps> = {}): SandboxOperationDeps {
  return {
    enabled: async () => true,
    listVersions: async (projectId) => (projectId === PROJECT ? [version()] : []),
    getVersion: async (projectId, id) =>
      projectId === PROJECT && id === VERSION ? version() : null,
    newestReady: async (projectId, name) =>
      projectId === PROJECT && name === "support-agent" ? version() : null,
    startRun: async () => ({ ok: true, run: run({ status: "queued", result: null }) }),
    getRun: async (projectId, id) => (projectId === PROJECT && id === RUN ? run() : null),
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
}

function call(
  id: string,
  params: Record<string, unknown>,
  overrides: Partial<SandboxOperationDeps> = {},
  caller: McpAuthContext = auth,
) {
  return dispatchOperation(id, params, {
    registry: buildRegistry(sandboxOperations(fakeDeps(overrides))),
    auth: caller,
  });
}

function ok<Data>(result: Awaited<ReturnType<typeof call>>): DispatchSuccess & { data: Data } {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as DispatchSuccess & { data: Data };
}

function failure(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: false }>;
}

const IDS = ["sandbox_list", "sandbox_get_version", "sandbox_run", "sandbox_get_run"];
const PARAMS: Record<string, Record<string, unknown>> = {
  sandbox_list: {},
  sandbox_get_version: { versionId: VERSION },
  sandbox_run: { versionId: VERSION, input: { message: "hi" } },
  sandbox_get_run: { runId: RUN },
};

// — Listing and flag ——————————————————————————————————————————————————————————

test("sandboxes: the tools are listed only when the flag is on for the caller", () => {
  const on = assembleOperations({ sandboxes: true }).map((operation) => operation.id);
  const off = assembleOperations({ sandboxes: false }).map((operation) => operation.id);
  for (const id of IDS) {
    assert.ok(on.includes(id), `${id} is listed with the flag on`);
    assert.ok(!off.includes(id), `${id} is not listed with the flag off`);
  }
  assert.ok(!assembleOperations().some((operation) => operation.id.startsWith("sandbox_")));
});

test("sandboxes: only sandbox_run mutates, and read-only assembly drops it", () => {
  const mutating = sandboxOperations(fakeDeps())
    .filter((operation) => operation.mutates)
    .map((operation) => operation.id);
  assert.deepEqual(mutating, ["sandbox_run"]);
  const readOnly = assembleOperations({ sandboxes: true, includeWrites: false });
  assert.ok(!readOnly.some((operation) => operation.id === "sandbox_run"));
});

for (const id of IDS) {
  test(`sandboxes: ${id} refuses a project with the flag off`, async () => {
    const asked: string[] = [];
    const result = failure(
      await call(id, PARAMS[id] ?? {}, {
        enabled: async (projectId) => {
          asked.push(projectId);
          return false;
        },
      }),
    );
    assert.equal(result.error, "forbidden");
    assert.match(result.message, /Ratel sandbox is not on for this project/);
    assert.deepEqual(asked, [PROJECT]);
  });

  test(`sandboxes: ${id} refuses another project than the one of the key`, async () => {
    const result = failure(await call(id, { ...PARAMS[id], projectId: OTHER_PROJECT }));
    assert.equal(result.error, "forbidden");
  });
}

test("sandboxes: an OAuth caller with no membership in the project gets not_found", async () => {
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_1",
    userId: "user-1",
    memberships: [
      {
        organizationId: "org-1",
        role: "admin",
        organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
      },
    ],
  } as McpAuthContext;
  const result = await dispatchOperation(
    "sandbox_get_version",
    { projectId: OTHER_PROJECT, versionId: VERSION },
    {
      registry: buildRegistry(sandboxOperations(fakeDeps())),
      auth: oauth,
      projectOwner: async () => ({ organizationId: "org-2" }),
    },
  );
  assert.equal(failure(result).error, "not_found");
});

// — sandbox_list ——————————————————————————————————————————————————————————————

test("sandbox_list: groups the versions by sandbox, newest first, with the newest ready one", async () => {
  const older = version({ id: "55555555-5555-4555-8555-555555555555", status: "failed" });
  const result = ok<{
    sandboxes: Array<{
      name: string;
      newestReadyVersionId: string | null;
      versions: Array<{ versionId: string; status: string }>;
    }>;
  }>(await call("sandbox_list", {}, { listVersions: async () => [version(), older] }));
  assert.equal(result.data.sandboxes.length, 1);
  const [sandbox] = result.data.sandboxes;
  assert.equal(sandbox?.name, "support-agent");
  assert.equal(sandbox?.newestReadyVersionId, VERSION);
  assert.deepEqual(
    sandbox?.versions.map((row) => row.status),
    ["ready", "failed"],
  );
  assert.match(result.hint ?? "", /sandbox_get_version/);
});

test("sandbox_list: an empty project says how to push a version", async () => {
  const result = ok<{ sandboxes: unknown[] }>(
    await call("sandbox_list", {}, { listVersions: async () => [] }),
  );
  assert.deepEqual(result.data.sandboxes, []);
  assert.match(result.hint ?? "", /ratel push/);
});

// — sandbox_get_version ———————————————————————————————————————————————————————

test("sandbox_get_version: returns the input example, the declared params and the smoke result", async () => {
  const result = ok<{
    versionId: string;
    status: string;
    input: { example: unknown };
    params: Array<{ name: string; type: string; options?: unknown[]; default?: unknown }>;
    tools: Array<{ name: string; mode: string }>;
    smoke: { ok: boolean; output?: unknown };
  }>(await call("sandbox_get_version", { versionId: VERSION }));
  assert.equal(result.data.status, "ready");
  assert.deepEqual(result.data.input.example, { message: "Where is my order?" });
  assert.deepEqual(
    result.data.params.map((param) => param.name),
    ["tone", "maxSteps"],
  );
  assert.deepEqual(result.data.params[0]?.options, ["formal", "casual"]);
  assert.deepEqual(result.data.tools, [
    { name: "lookup_order", mode: "simulated" },
    { name: "refund", mode: "simulated" },
  ]);
  assert.equal(result.data.smoke.ok, true);
  assert.match(result.hint ?? "", /sandbox_run/);
});

test("sandbox_get_version: a version of another project is not_found", async () => {
  const result = failure(
    await call("sandbox_get_version", { versionId: VERSION }, { getVersion: async () => null }),
  );
  assert.equal(result.error, "not_found");
});

// — sandbox_run ———————————————————————————————————————————————————————————————

test("sandbox_run: refuses an undeclared param and lists the declared ones", async () => {
  let started = false;
  const result = failure(
    await call(
      "sandbox_run",
      { versionId: VERSION, input: {}, params: { temperature: 0.2 } },
      {
        startRun: async () => {
          started = true;
          return { ok: true, run: run() };
        },
      },
    ),
  );
  assert.equal(result.error, "invalid_params");
  assert.match(result.message, /temperature/);
  assert.match(result.message, /tone, maxSteps/);
  assert.equal(started, false);
});

test("sandbox_run: a version with no params says so when a param is given", async () => {
  const bare = version({ config: { name: "support-agent", input: { example: null } } });
  const result = failure(
    await call(
      "sandbox_run",
      { versionId: VERSION, input: {}, params: { tone: "formal" } },
      { getVersion: async () => bare },
    ),
  );
  assert.equal(result.error, "invalid_params");
  assert.match(result.message, /declares no params/);
});

test("sandbox_run: starts a strict run for the caller and returns the result when it ends soon", async () => {
  let options: StartRunOptions | undefined;
  let reads = 0;
  const result = ok<{ runId: string; status: string; input: unknown; output: unknown }>(
    await call(
      "sandbox_run",
      { versionId: VERSION, input: { message: "hi" }, params: { tone: "casual" } },
      {
        startRun: async (_version, _input, given) => {
          options = given;
          return { ok: true, run: run({ status: "queued", result: null }) };
        },
        getRun: async () => {
          reads += 1;
          return reads < 2 ? run({ status: "running", result: null }) : run();
        },
      },
    ),
  );
  assert.equal(options?.projectId, PROJECT);
  assert.equal(options?.organizationId, "org-1");
  assert.equal(options?.strict, true);
  assert.deepEqual(options?.params, { tone: "casual" });
  assert.equal(result.data.status, "completed");
  assert.deepEqual(Object.keys(result.data).slice(0, 4), ["runId", "status", "input", "output"]);
});

test("sandbox_run: a run that does not end in the wait returns its id and a hint to poll", async () => {
  let clock = 0;
  const result = ok<{ runId: string; status: string }>(
    await call(
      "sandbox_run",
      { name: "support-agent", input: { message: "hi" } },
      {
        getRun: async () => run({ status: "running", result: null }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
  );
  assert.equal(result.data.runId, RUN);
  assert.equal(result.data.status, "running");
  assert.match(result.hint ?? "", /sandbox_get_run/);
  assert.match(result.hint ?? "", new RegExp(RUN));
  assert.ok(clock <= 30_000, "the wait stays well under the 60 second limit of a call");
});

test("sandbox_run: a name with no ready version is not_found", async () => {
  const result = failure(await call("sandbox_run", { name: "nope", input: {} }));
  assert.equal(result.error, "not_found");
});

test("sandbox_run: needs a versionId or a name", async () => {
  const result = failure(await call("sandbox_run", { input: {} }));
  assert.equal(result.error, "invalid_params");
});

test("sandbox_run: a version that is not ready is a conflict with the reason", async () => {
  const result = failure(
    await call(
      "sandbox_run",
      { versionId: VERSION, input: {} },
      {
        startRun: async () => ({
          ok: false,
          reason: "not_ready",
          message: "The version is preparing. Run a version that is ready.",
        }),
      },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "not_ready");
  assert.match(result.message, /preparing/);
});

// — sandbox_get_run ———————————————————————————————————————————————————————————

test("sandbox_get_run: shows input and output first, then tool calls and the logs", async () => {
  const result = ok<{
    input: unknown;
    output: unknown;
    toolCalls: Array<{ name: string }>;
    logs: { text: string; truncated: boolean };
  }>(await call("sandbox_get_run", { runId: RUN }));
  assert.deepEqual(Object.keys(result.data).slice(0, 4), ["runId", "status", "input", "output"]);
  assert.deepEqual(result.data.output, { reply: "It ships today." });
  assert.deepEqual(
    result.data.toolCalls.map((toolCall) => toolCall.name),
    ["lookup_order"],
  );
  assert.deepEqual(result.data.logs, { text: "started\nanswered", truncated: false });
  assert.notEqual(result.truncated, true);
});

test("sandbox_get_run: long logs keep their end and are marked truncated", async () => {
  const logs = `${"x".repeat(10_000)}THE END`;
  const result = ok<{ logs: { text: string; truncated: boolean } }>(
    await call("sandbox_get_run", { runId: RUN }, { getRun: async () => run({ logs }) }),
  );
  assert.equal(result.data.logs.truncated, true);
  assert.ok(result.data.logs.text.endsWith("THE END"));
  assert.ok(result.data.logs.text.length < logs.length);
  assert.equal(result.truncated, true);
});

test("sandbox_get_run: a failed run shows its error code and reason", async () => {
  const result = ok<{ status: string; error: { code: string; message: string } }>(
    await call(
      "sandbox_get_run",
      { runId: RUN },
      {
        getRun: async () =>
          run({
            status: "timed_out",
            errorCode: "timeout",
            reason: "The run took too long.",
            result: null,
          }),
      },
    ),
  );
  assert.equal(result.data.status, "failed");
  assert.deepEqual(result.data.error, { code: "timeout", message: "The run took too long." });
});

test("sandbox_get_run: an active run gives a hint to poll again", async () => {
  const result = ok<{ status: string }>(
    await call(
      "sandbox_get_run",
      { runId: RUN },
      { getRun: async () => run({ status: "running", result: null }) },
    ),
  );
  assert.equal(result.data.status, "running");
  assert.match(result.hint ?? "", /sandbox_get_run/);
});

test("sandbox_get_run: a run of another project is not_found", async () => {
  const result = failure(
    await call("sandbox_get_run", { runId: RUN }, { getRun: async () => null }),
  );
  assert.equal(result.error, "not_found");
});
