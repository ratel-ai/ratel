import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { createPgSandboxGatewayStore } from "@/lib/views/sandboxes/adapters/pg-gateway-store";
import { createPgSandboxRunStore } from "@/lib/views/sandboxes/adapters/pg-store";
import { gatewayChannel } from "@/lib/views/sandboxes/domain/channels";
import type { RunStartRequest } from "@/lib/views/sandboxes/domain/command";
import { createPgFakeStore } from "@/lib/views/sandboxes/fakes/adapters/pg-fake-store";
import { createFakeService, type FakeService } from "@/lib/views/sandboxes/fakes/service";
import { createGateway, type Gateway } from "../src/gateway";
import { type CommandListener, createCommandListener } from "../src/listener";
import { getLogger } from "../src/logger";
import { loadValidator } from "../src/protocol";
import {
  createTestDatabase,
  OWNER,
  PROJECT,
  SECRET,
  TEST_DATABASE_URL,
  type TestDatabase,
  TestWorker,
  tokenFor,
  until,
} from "./support";

/**
 * The gateway against a real Postgres: commands written by the web-side store
 * reach a connected worker through LISTEN/NOTIFY, events are stored once and
 * acked, nothing is lost over a restart, silent runs go lost, and SIGTERM
 * drains. Skipped without TEST_DATABASE_URL.
 */

const skip = TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not set";
let database: TestDatabase;

before(async () => {
  if (!skip) database = await createTestDatabase();
});
after(async () => {
  await database?.drop();
});

interface Running {
  gateway: Gateway;
  listener: CommandListener;
  port: number;
  stop(): Promise<void>;
}

async function startGateway(
  gatewayId: string,
  limits: { leaseTimeoutMs?: number } = {},
  fakes?: FakeService,
): Promise<Running> {
  const gateway = createGateway({
    fakes,
    gatewayId,
    store: createPgSandboxGatewayStore(database.db),
    validator: loadValidator(),
    tokenSecret: SECRET,
    logger: getLogger("test/gateway"),
    limits,
    // Long poll: a delivery inside a test came through NOTIFY or a (re)connect read.
    pollIntervalMs: 60_000,
    lostSweepIntervalMs: limits.leaseTimeoutMs ? 100 : 60_000,
  });
  const listener = createCommandListener({
    connectionString: database.url,
    ssl: false,
    channel: gatewayChannel(gatewayId),
    onWake: () => gateway.wake(),
    logger: getLogger("test/listener"),
  });
  const port = await gateway.listen(0, "127.0.0.1");
  await listener.start();
  return {
    gateway,
    listener,
    port,
    async stop() {
      await listener.stop();
      await gateway.close();
    },
  };
}

async function runnerId(instanceId = "rnr_test"): Promise<string> {
  const { rows } = await database.pool.query<{ id: string }>(
    "select id from sandbox_runners where instance_id = $1",
    [instanceId],
  );
  return rows[0]!.id;
}

async function startRun(
  instanceId = "rnr_test",
  toolModes: RunStartRequest["toolModes"] = {},
): Promise<string> {
  const request: RunStartRequest = {
    projectId: PROJECT,
    ownerUserId: OWNER,
    runnerId: await runnerId(instanceId),
    sandboxId: "workflow-label",
    input: { workflowId: "wf_1" },
    params: { maxTokens: 300 },
    toolModes,
    context: {},
    configHash: "b".repeat(64),
    overrides: ["maxTokens"],
  };
  const result = await createPgSandboxRunStore(database.db).startRun(request);
  assert.ok(result.ok, JSON.stringify(result));
  return result.runId;
}

async function storedSeqs(runId: string): Promise<number[]> {
  const { rows } = await database.pool.query<{ seq: number }>(
    "select seq from sandbox_run_events where run_id = $1 order by seq",
    [runId],
  );
  return rows.map((r) => r.seq);
}

async function runStatus(runId: string): Promise<string> {
  const { rows } = await database.pool.query<{ status: string }>(
    "select status from sandbox_runs where id = $1",
    [runId],
  );
  return rows[0]!.status;
}

test("a run started by the store reaches the worker as run.start, and its events are stored once and acked", {
  skip,
}, async () => {
  const running = await startGateway("gw_a");
  const worker = await TestWorker.connect(running.port);
  try {
    const runId = await startRun();
    const start = await worker.waitFor((f) => f.type === "run.start" && f.runId === runId);
    assert.equal(start.payload.sandboxId, "workflow-label");
    assert.deepEqual(start.payload.params, { maxTokens: 300 });

    worker.send("run.ack", {}, runId);
    await until(async () => (await runStatus(runId)) === "running");
    const { rows } = await database.pool.query(
      "select acked_at from sandbox_commands where run_id = $1",
      [runId],
    );
    assert.ok(rows[0].acked_at, "the run.start command is acked once the worker acks");

    for (const seq of [1, 2, 3]) worker.event(runId, seq);
    worker.event(runId, 2);
    await worker.waitFor(
      (f) => f.type === "events.ack" && f.runId === runId && f.payload.seq === 3,
    );
    assert.deepEqual(await storedSeqs(runId), [1, 2, 3]);
    assert.deepEqual(worker.invalid, [], "every frame the gateway sent is valid sandbox/v1");
  } finally {
    worker.terminate();
    await running.stop();
  }
});

test("a worker that resends after a reconnect gets every event stored once and acked with the highest seq", {
  skip,
}, async () => {
  const running = await startGateway("gw_b");
  let worker = await TestWorker.connect(running.port, tokenFor(), "rnr_resend");
  try {
    const runId = await startRun("rnr_resend");
    await worker.waitFor((f) => f.type === "run.start" && f.runId === runId);
    worker.send("run.ack", {}, runId);
    worker.event(runId, 1);
    worker.event(runId, 2);
    await worker.waitFor((f) => f.type === "events.ack" && f.payload.seq === 2);
    worker.terminate();

    worker = await TestWorker.connect(running.port, tokenFor(), "rnr_resend");
    for (const seq of [1, 2, 3, 4]) worker.event(runId, seq);
    worker.send("run.end", { status: "ok", output: { name: "Refunds" } }, runId, 5);
    await worker.waitFor((f) => f.type === "events.ack" && f.payload.seq === 5);
    assert.deepEqual(await storedSeqs(runId), [1, 2, 3, 4, 5]);
    assert.equal(await runStatus(runId), "ok");
  } finally {
    worker.terminate();
    await running.stop();
  }
});

test("a gateway restart re-reads unacked commands and loses none", { skip }, async () => {
  const first = await startGateway("gw_c1");
  const worker = await TestWorker.connect(first.port, tokenFor(), "rnr_restart");
  const runId = await startRun("rnr_restart");
  await worker.waitFor((f) => f.type === "run.start" && f.runId === runId);
  worker.terminate();
  await first.stop();

  // The cancel is written while no gateway runs: its NOTIFY reaches nobody.
  await database.pool.query(
    "update sandbox_runners set gateway_id = 'gw_c1' where instance_id = 'rnr_restart'",
  );
  const cancel = await createPgSandboxRunStore(database.db).cancelRun({
    runId,
    projectId: PROJECT,
    ownerUserId: OWNER,
    reason: "stop",
  });
  assert.ok(cancel.ok);

  const second = await startGateway("gw_c2");
  const again = await TestWorker.connect(second.port, tokenFor(), "rnr_restart");
  try {
    await again.waitFor((f) => f.type === "run.start" && f.runId === runId);
    await again.waitFor((f) => f.type === "run.cancel" && f.runId === runId);
    const { rows } = await database.pool.query(
      "select gateway_id, kind from sandbox_commands where run_id = $1 order by created_at",
      [runId],
    );
    assert.deepEqual(
      rows.map((r) => r.gateway_id),
      ["gw_c2", "gw_c2"],
      "the commands moved to the new gateway",
    );
  } finally {
    again.terminate();
    await second.stop();
  }
});

test("a run with no lease within the lease timeout is marked lost", { skip }, async () => {
  const running = await startGateway("gw_d", { leaseTimeoutMs: 400 });
  const worker = await TestWorker.connect(running.port, tokenFor(), "rnr_lost");
  try {
    const leased = await startRun("rnr_lost");
    const silent = await startRun("rnr_lost");
    await worker.waitFor((f) => f.type === "run.start" && f.runId === silent);
    worker.send("run.ack", {}, leased);
    worker.send("run.ack", {}, silent);
    const keepAlive = setInterval(() => worker.send("run.lease", { elapsedMs: 100 }, leased), 100);
    try {
      await until(async () => (await runStatus(silent)) === "lost", 5_000);
      assert.equal(await runStatus(leased), "running");
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    worker.terminate();
    await running.stop();
  }
});

test("a frame about another owner's run closes the socket", { skip }, async () => {
  const running = await startGateway("gw_e");
  const owner = await TestWorker.connect(running.port, tokenFor(), "rnr_owner");
  const intruder = await TestWorker.connect(
    running.port,
    tokenFor({ ownerUserId: "user_other" }),
    "rnr_intruder",
  );
  try {
    const runId = await startRun("rnr_owner");
    await owner.waitFor((f) => f.type === "run.start" && f.runId === runId);
    intruder.event(runId, 1);
    assert.equal(await intruder.waitClosed(), 4003);
    assert.deepEqual(await storedSeqs(runId), []);
  } finally {
    owner.terminate();
    await running.stop();
  }
});

test("SIGTERM sends drain to every runner before the process exits", { skip }, async () => {
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      SANDBOX_GATEWAY_TOKEN_SECRET: SECRET,
      PORT: String(port),
      GATEWAY_ID: "gw_sigterm",
      LOG_LEVEL: "silent",
      TSX_TSCONFIG_PATH: "tsconfig.json",
    },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  try {
    await until(
      async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok === true,
      20_000,
    );
    const worker = await TestWorker.connect(port, tokenFor(), "rnr_sigterm");
    child.kill("SIGTERM");
    const drain = await worker.waitFor((f) => f.type === "drain");
    assert.equal(drain.payload.reason, "gateway shutdown");
    worker.terminate();
    assert.equal(await exited, 0);
    assert.deepEqual(worker.invalid, []);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a gateway restart mid-run with a live reader: the reader sees every seq once, in order", {
  skip,
}, async () => {
  const store = createPgSandboxRunStore(database.db);
  const first = await startGateway("gw_f1");
  let worker = await TestWorker.connect(first.port, tokenFor(), "rnr_reader");
  const runId = await startRun("rnr_reader");
  await worker.waitFor((f) => f.type === "run.start" && f.runId === runId);
  worker.send("run.ack", {}, runId);

  // A reader that resumes from its last seq, as the SSE stream does.
  const seen: number[] = [];
  let reading = true;
  const reader = (async () => {
    while (reading) {
      for (const row of await store.readEventsAfter(runId, seen.at(-1) ?? 0)) seen.push(row.seq);
      if (
        (await runStatus(runId)) === "ok" &&
        (await store.readEventsAfter(runId, seen.at(-1) ?? 0)).length === 0
      )
        return;
      await new Promise((r) => setTimeout(r, 30));
    }
  })();

  worker.event(runId, 1);
  worker.event(runId, 2);
  worker.event(runId, 4); // seq 3 is lost on the way: a gap
  await worker.waitFor((f) => f.type === "events.ack" && f.payload.seq === 2);
  await until(async () => (await storedSeqs(runId)).includes(4));
  worker.terminate();
  await first.stop();

  const second = await startGateway("gw_f2");
  worker = await TestWorker.connect(second.port, tokenFor(), "rnr_reader");
  try {
    // The worker resends everything after the last ack.
    for (const seq of [3, 4]) worker.event(runId, seq);
    worker.send("run.end", { status: "ok", output: { name: "Refunds" } }, runId, 5);
    await worker.waitFor((f) => f.type === "events.ack" && f.payload.seq === 5);
    await withTimeout(reader, 5_000);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.deepEqual(await storedSeqs(runId), [1, 2, 3, 4, 5]);
  } finally {
    reading = false;
    worker.terminate();
    await second.stop();
  }
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms),
    ),
  ]);
}

test("a fake request is answered on the socket; over the daily cap the run fails with the generic run_failed and the worker gets run.cancel", {
  skip,
}, async () => {
  const generated: string[] = [];
  const alerts: unknown[] = [];
  const fakes = createFakeService({
    store: createPgFakeStore(database.db),
    model: {
      async generate(input) {
        generated.push(input.request.tool);
        return {
          result: { id: "T-1", status: "open" },
          state: { tickets: ["T-1"] },
          isError: false,
        };
      },
    },
    alerts: { capReached: (input) => alerts.push(input) },
    dailyCap: 1,
  });
  const running = await startGateway("gw_fake", {}, fakes);
  const worker = await TestWorker.connect(running.port, tokenFor(), "rnr_fake");
  try {
    const runId = await startRun("rnr_fake", { createTicket: "fake" });
    await worker.waitFor((f) => f.type === "run.start" && f.runId === runId);
    worker.send("run.ack", {}, runId);
    await until(async () => (await runStatus(runId)) === "running");

    worker.send(
      "tool.fake.request",
      { callId: "call_1", tool: "createTicket", args: { title: "Down" } },
      runId,
    );
    const answer = await worker.waitFor(
      (f) => f.type === "tool.fake.result" && f.payload.callId === "call_1",
    );
    assert.deepEqual(answer.payload, {
      callId: "call_1",
      result: { id: "T-1", status: "open" },
      isError: false,
      source: "generated",
    });

    worker.send(
      "tool.fake.request",
      { callId: "call_2", tool: "createTicket", args: { title: "Again" } },
      runId,
    );
    const cancel = await worker.waitFor((f) => f.type === "run.cancel" && f.runId === runId);
    assert.deepEqual(cancel.payload, { reason: "run_failed" });
    const { rows } = await database.pool.query<{ status: string; error: unknown }>(
      "select status, error from sandbox_runs where id = $1",
      [runId],
    );
    assert.deepEqual(rows[0], {
      status: "error",
      error: { code: "run_failed", message: "The run failed." },
    });
    assert.doesNotMatch(
      JSON.stringify(worker.frames.filter((f) => f.runId === runId)),
      /\bcap\b|limit/i,
    );

    worker.send("run.end", { status: "canceled" }, runId, 1);
    await worker.waitFor((f) => f.type === "events.ack" && f.runId === runId);
    assert.equal(await runStatus(runId), "error", "the worker's own end does not undo the failure");
    assert.deepEqual(generated, ["createTicket"]);
    assert.equal(alerts.length, 1);
    assert.deepEqual(worker.invalid, []);
  } finally {
    worker.terminate();
    await running.stop();
  }
});
