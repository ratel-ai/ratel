import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import * as schema from "@/lib/views/sandboxes/schema";
import { sandboxCommands, sandboxRuns, sandboxSessions } from "@/lib/views/sandboxes/schema";
import { createPgSandboxRunStore, type SandboxDb } from "../adapters/pg-store";
import { readRecordedItems, readTraceMetrics } from "../adapters/recorded-items";
import type { RunNotifications } from "../adapters/run-notifications";
import { runChannel } from "../domain/channels";
import { createPgFakeStore } from "../fakes/adapters/pg-fake-store";
import { argsKey } from "../fakes/domain/fake";
import { createFakeService } from "../fakes/service";
import {
  handleCancelRun,
  handleCompareItems,
  handleConfirmTool,
  handleListPins,
  handleListRecordedItems,
  handleListRunners,
  handleListRuns,
  handlePinFake,
  handleRunEvents,
  handleRunMetrics,
  handleStartRun,
  handleUnpinFake,
  type SandboxRunApiDeps,
} from "../run-api";

/**
 * The session-authenticated sandbox run API against real PGlite: a run starts
 * only on the caller's own runner, overrides are checked against the
 * manifest, the flag hides every route, and the SSE stream resumes after
 * Last-Event-ID and then follows new events in order.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const MY_RUNNER = "33333333-3333-4333-8333-333333333333";
const THEIR_RUNNER = "44444444-4444-4444-8444-444444444444";
const ME = "user_me";
const MANIFEST = {
  sdk: { language: "typescript", name: "@ratel-ai/sandbox", version: "0.1.0" },
  providers: [],
  sandboxes: [
    {
      id: "workflow-label",
      modelResolver: "builtin",
      input: {
        kind: "structured",
        schema: {
          type: "object",
          required: ["workflowId"],
          properties: { workflowId: { type: "string" } },
        },
      },
      params: [
        { name: "model", kind: "model", default: "anthropic/claude-sonnet-5-5" },
        { name: "maxTokens", kind: "scalar", type: "int", default: 400, min: 50, max: 2000 },
      ],
      context: [],
    },
    {
      id: "docs-agent",
      modelResolver: "builtin",
      input: { kind: "chat" },
      params: [
        { name: "model", kind: "model", default: "anthropic/claude-sonnet-5-5" },
        {
          name: "tools",
          kind: "tools",
          default: [
            { name: "searchDocs", description: "Search the docs", hint: "readOnly" },
            { name: "createTicket", description: "Open a support ticket", hint: "sideEffect" },
            { name: "notifyTeam", description: "Post to the team", hint: "none" },
          ],
        },
      ],
      context: [],
    },
  ],
};

async function setup(options: { enabled?: boolean } = {}) {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
  `);
  await client.query(
    `insert into sandbox_runners (id, project_id, owner_user_id, instance_id, gateway_id, manifest) values
     ($1, $3, $4, 'rnr_me', 'gw_1', $5), ($2, $3, 'user_them', 'rnr_them', 'gw_1', $5)`,
    [MY_RUNNER, THEIR_RUNNER, PROJ, ME, JSON.stringify(MANIFEST)],
  );
  const db = drizzle(client, { schema }) as unknown as SandboxDb;
  const tracked: string[] = [];
  const deps: SandboxRunApiDeps = {
    getSession: async () => ({ user: { id: "u-row", externalId: ME } }),
    findProjectScope: async (projectId) =>
      projectId === PROJ ? { project: { id: PROJ }, organization: { id: ORG } } : null,
    sandboxesEnabled: async () => options.enabled ?? true,
    store: () => createPgSandboxRunStore(db),
    fakeStore: () => createPgFakeStore(db),
    recordedItems: (query) => readRecordedItems(db, query),
    traceMetrics: (query) => readTraceMetrics(db, query),
    now: () => new Date("2026-11-20T12:00:00Z"),
    notifications: () => pgliteNotifications(client),
    track: async (event) => {
      tracked.push(event);
    },
    pollIntervalMs: 5_000,
  };
  return { client, db, deps, tracked };
}

/** RunNotifications over PGlite's own LISTEN, the way the pg adapter wakes readers. */
function pgliteNotifications(client: PGlite): RunNotifications {
  return {
    subscribe(runId, onWake) {
      let unlisten: (() => Promise<void>) | undefined;
      let gone = false;
      void client
        .listen(runChannel(runId), () => onWake())
        .then((u) => {
          unlisten = u;
          if (gone) void u();
        });
      return () => {
        gone = true;
        void unlisten?.();
      };
    },
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const START = {
  runnerId: MY_RUNNER,
  sandboxId: "workflow-label",
  input: { workflowId: "wf_1" },
  params: { maxTokens: 300 },
};

test("POST runs starts a run on the caller's runner and returns its id; another user's runner is refused", async () => {
  const { db, deps, tracked } = await setup();
  const res = await handleStartRun(post(START), PROJ, deps);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { runId: string; configHash: string; overrides: string[] };
  assert.match(body.configHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(body.overrides, ["maxTokens"]);
  const runs = await db.select().from(sandboxRuns);
  assert.deepEqual(
    runs.map((r) => [r.id, r.runnerId, r.ownerUserId]),
    [[body.runId, MY_RUNNER, ME]],
  );
  assert.deepEqual(tracked, ["sandbox_run_started"]);

  const theirs = await handleStartRun(post({ ...START, runnerId: THEIR_RUNNER }), PROJ, deps);
  assert.equal(theirs.status, 403);
  assert.equal(((await theirs.json()) as { error: string }).error, "runner_not_owner");
});

test("an invalid override is refused with the param name, and a bad input with its path", async () => {
  const { deps } = await setup();
  const res = await handleStartRun(post({ ...START, params: { maxTokens: 9000 } }), PROJ, deps);
  assert.equal(res.status, 400);
  const body = (await res.json()) as {
    error: string;
    params: { param: string }[];
    message: string;
  };
  assert.equal(body.error, "invalid_params");
  assert.deepEqual(
    body.params.map((p) => p.param),
    ["maxTokens"],
  );
  assert.match(body.message, /^maxTokens /);

  const unknown = await handleStartRun(post({ ...START, params: { temperature: 1 } }), PROJ, deps);
  assert.deepEqual(
    ((await unknown.json()) as { params: { param: string }[] }).params.map((p) => p.param),
    ["temperature"],
  );

  const input = await handleStartRun(post({ ...START, input: {} }), PROJ, deps);
  assert.equal(input.status, 400);
  assert.equal(((await input.json()) as { error: string }).error, "invalid_input");
});

test("the runners list marks only the caller's online runner startable, with its concurrency", async () => {
  const { client, deps } = await setup();
  await client.query(`update sandbox_runners set max_concurrency = 3 where id = $1`, [MY_RUNNER]);
  const body = (await (await handleListRunners(PROJ, deps)).json()) as {
    runners: { id: string; startable: boolean; maxConcurrency: number }[];
  };
  const startable = Object.fromEntries(
    body.runners.map((r) => [r.id, [r.startable, r.maxConcurrency]]),
  );
  assert.deepEqual(startable, { [MY_RUNNER]: [true, 3], [THEIR_RUNNER]: [false, 1] });
});

test("a replay run's run.start command carries its source trace and arm; a bad replay is a 400", async () => {
  const { db, deps } = await setup();
  const replay = { sourceTraceId: "7b55d114b56c0667506050ec608264fd", arm: "candidate" };
  const res = await handleStartRun(post({ ...START, replay }), PROJ, deps);
  assert.equal(res.status, 201);
  const [command] = await db.select().from(sandboxCommands);
  assert.deepEqual((command?.payload as { replay?: unknown }).replay, replay);

  const bad = await handleStartRun(
    post({ ...START, replay: { sourceTraceId: "x", arm: "other" } }),
    PROJ,
    deps,
  );
  assert.equal(bad.status, 400);
});

const ITEM_TRACE = "7b55d114b56c0667506050ec608264fd";

async function recordedItem(client: PGlite, spanId: string, workflowId: string, reply?: string) {
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
     values (gen_random_uuid(), $1, $2, $3, 'root', 'chat', 3, 'llm_call', '2026-11-19T10:00:00Z', '2026-11-19T10:00:01Z', 1, 0, $4)`,
    [
      PROJ,
      ITEM_TRACE,
      spanId,
      JSON.stringify({
        "ratel.sandbox.id": "workflow-label",
        "ratel.sandbox.input": JSON.stringify({ workflowId }),
      }),
    ],
  );
  if (reply) {
    const payload = {
      provider: "anthropic",
      model: "m",
      ts: "2026-11-19T10:00:00Z",
      messages: [],
      input_message_count: 0,
      output: [{ role: "assistant", content: reply }],
    };
    await client.query(
      `insert into events (project_id, trace_id, span_id, payload) values ($1, $2, $3, $4)`,
      [PROJ, ITEM_TRACE, spanId, JSON.stringify(payload)],
    );
  }
}

test("GET items lists the sandbox's recorded items with input and recorded output", async () => {
  const { client, deps } = await setup();
  await recordedItem(client, "s1", "wf_1", '{"name":"Refunds"}');

  const res = await handleListRecordedItems(
    new Request("http://localhost/api?sandboxId=workflow-label"),
    PROJ,
    deps,
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: {
      spanId: string;
      traceId: string;
      input: unknown;
      recordedOutput: unknown;
      startedAt: string;
    }[];
  };
  assert.deepEqual(
    body.items.map((i) => [i.spanId, i.traceId, i.input, i.recordedOutput]),
    [["s1", ITEM_TRACE, { workflowId: "wf_1" }, { name: "Refunds" }]],
  );
  // The list may hold more than one compare takes, so the 50-item limit is the compare's to refuse.
  assert.equal(
    (
      await handleListRecordedItems(
        new Request("http://localhost/api?sandboxId=workflow-label&limit=100"),
        PROJ,
        deps,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleListRecordedItems(
        new Request("http://localhost/api?sandboxId=workflow-label&limit=500"),
        PROJ,
        deps,
      )
    ).status,
    400,
  );
});

test("POST compare resolves the picked items and refuses more than 50", async () => {
  const { client, deps } = await setup();
  await recordedItem(client, "a1", "wf_1", '{"name":"A"}');
  await recordedItem(client, "a2", "wf_2");

  const res = await handleCompareItems(
    post({ sandboxId: "workflow-label", spanIds: ["a2", "a1", "ff"] }),
    PROJ,
    deps,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: { spanId: string; sourceTraceId: string; input: unknown; recordedOutput: unknown }[];
    missing: string[];
  };
  assert.deepEqual(
    body.items.map((i) => [i.spanId, i.sourceTraceId, i.recordedOutput]),
    [
      ["a2", ITEM_TRACE, null],
      ["a1", ITEM_TRACE, { name: "A" }],
    ],
    "in the order picked",
  );
  assert.deepEqual(body.missing, ["ff"]);

  const tooMany = await handleCompareItems(
    post({ sandboxId: "workflow-label", spanIds: Array.from({ length: 51 }, (_, i) => `a${i}`) }),
    PROJ,
    deps,
  );
  assert.equal(tooMany.status, 400);
  assert.match(((await tooMany.json()) as { message: string }).message, /at most 50/);
  assert.equal(
    (await handleCompareItems(post({ sandboxId: "workflow-label", spanIds: [] }), PROJ, deps))
      .status,
    400,
  );
});

test("GET run metrics sums the run's trace once its spans are in; another user's run is not found", async () => {
  const { client, db, deps } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const early = (await (await handleRunMetrics(PROJ, runId, deps)).json()) as { ready: boolean };
  assert.equal(early.ready, false, "no trace id before the run ends");

  const trace = "2c33a169e1d648ce2fbb7f04432f1a16";
  await createPgSandboxRunStore(db).appendEvents(runId, [
    { seq: 1, kind: "run.end", payload: { status: "ok", traceId: trace } },
  ]);
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes, input_tokens, output_tokens, cost_usd) values
     (gen_random_uuid(), $1, $2, 'root', null, 'invoke_workflow', 1, 'agent', now(), now(), 2729, 0, '{}', null, null, null),
     (gen_random_uuid(), $1, $2, 'c1', 'root', 'chat', 3, 'llm_call', now(), now(), 2726, 0, '{}', 1601, 70, 0.003902)`,
    [PROJ, trace],
  );
  const res = await handleRunMetrics(PROJ, runId, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ready: true,
    traceId: trace,
    inputTokens: 1601,
    outputTokens: 70,
    costUsd: 0.003902,
    latencyMs: 2729,
  });

  await client.query(`update sandbox_runs set owner_user_id = 'user_them' where id = $1`, [runId]);
  assert.equal((await handleRunMetrics(PROJ, runId, deps)).status, 404);
});

test("with cloud-sandboxes off every route answers 404", async () => {
  const { deps } = await setup({ enabled: false });
  const runId = "55555555-5555-4555-8555-555555555555";
  const statuses = [
    (await handleListRunners(PROJ, deps)).status,
    (await handleStartRun(post(START), PROJ, deps)).status,
    (await handleCancelRun(PROJ, runId, deps)).status,
    (await handleRunEvents(new Request("http://localhost/api"), PROJ, runId, deps)).status,
    (await handleListRuns(new Request("http://localhost/api?sandboxId=workflow-label"), PROJ, deps))
      .status,
    (
      await handleListRecordedItems(
        new Request("http://localhost/api?sandboxId=workflow-label"),
        PROJ,
        deps,
      )
    ).status,
    (await handleCompareItems(post({ sandboxId: "workflow-label", spanIds: ["a"] }), PROJ, deps))
      .status,
    (await handleRunMetrics(PROJ, runId, deps)).status,
  ];
  assert.deepEqual(statuses, [404, 404, 404, 404, 404, 404, 404, 404]);
});

test("GET runs lists only the caller's runs of the sandbox, newest first", async () => {
  const { client, deps } = await setup();
  const mine = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
    sessionId: string;
  };
  await client.query(
    `insert into sandbox_runs (project_id, sandbox_id, owner_user_id, runner_id, config_hash, input) values ($1, 'workflow-label', 'user_them', $2, 'h', '{}')`,
    [PROJ, THEIR_RUNNER],
  );

  const res = await handleListRuns(
    new Request("http://localhost/api?sandboxId=workflow-label"),
    PROJ,
    deps,
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    runs: {
      id: string;
      sessionId: string;
      status: string;
      overrides: string[];
      params: unknown;
      createdAt: string;
    }[];
  };
  assert.deepEqual(
    body.runs.map((r) => [r.id, r.sessionId, r.status]),
    [[mine.runId, mine.sessionId, "queued"]],
  );
  assert.deepEqual(body.runs[0]!.overrides, ["maxTokens"]);
  assert.deepEqual(body.runs[0]!.params, { maxTokens: 300 });
  assert.match(body.runs[0]!.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("GET runs without a sandbox id is a 400", async () => {
  const { deps } = await setup();
  const res = await handleListRuns(new Request("http://localhost/api"), PROJ, deps);
  assert.equal(res.status, 400);
});

test("cancel queues run.cancel for the caller's run", async () => {
  const { db, deps, tracked } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const res = await handleCancelRun(PROJ, runId, deps);
  assert.equal(res.status, 202);
  const kinds = (await db.select().from(sandboxCommands)).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["run.cancel", "run.start"]);
  assert.deepEqual(tracked, ["sandbox_run_started", "sandbox_run_cancelled"]);
});

test("the SSE stream replays after Last-Event-ID, then delivers new events in order until the run ends", async () => {
  const { db, deps } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const store = createPgSandboxRunStore(db);
  const delta = (seq: number) => ({
    seq,
    kind: "text.delta",
    payload: { kind: "text.delta", text: `t${seq}` },
  });
  await store.appendEvents(runId, [delta(1), delta(2), delta(3)]);

  const request = new Request("http://localhost/api", { headers: { "last-event-id": "1" } });
  const res = await handleRunEvents(request, PROJ, runId, deps);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = res.body!.getReader();
  const frames = collectFrames(reader);

  // Live events arrive through the NOTIFY wake-up, well before the 5 s poll.
  await new Promise((r) => setTimeout(r, 200));
  await store.appendEvents(runId, [delta(4)]);
  await store.appendEvents(runId, [
    { seq: 5, kind: "run.end", payload: { status: "ok", output: { name: "Refunds" } } },
  ]);

  const received = await withTimeout(frames, 4_000);
  assert.deepEqual(
    received.filter((f) => f.id).map((f) => [f.id, f.event]),
    [
      ["2", "text.delta"],
      ["3", "text.delta"],
      ["4", "text.delta"],
      ["5", "run.end"],
    ],
  );
  assert.deepEqual(received.at(-1), {
    id: undefined,
    event: "run.status",
    data: '{"status":"ok","error":null}',
  });
});

async function collectFrames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split("\n\n")
    .filter((block) => block.trim() && !block.startsWith(":") && !block.startsWith("retry"))
    .map((block) => {
      const fields = Object.fromEntries(
        block
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
      );
      return { id: fields.id as string | undefined, event: fields.event, data: fields.data };
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms),
    ),
  ]);
}

test("the SSE stream never skips a seq that lands after a later one", async () => {
  const { db, deps } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const store = createPgSandboxRunStore(db);
  const log = (seq: number) => ({
    seq,
    kind: "log",
    payload: { kind: "log", level: "info", message: `step ${seq}` },
  });
  await store.appendEvents(runId, [log(1)]);

  const res = await handleRunEvents(new Request("http://localhost/api"), PROJ, runId, deps);
  const frames = collectFrames(res.body!.getReader());
  await new Promise((r) => setTimeout(r, 200));
  // After a reconnect the end can be stored before the events it follows.
  await store.appendEvents(runId, [{ seq: 4, kind: "run.end", payload: { status: "ok" } }]);
  await new Promise((r) => setTimeout(r, 200));
  await store.appendEvents(runId, [log(2), log(3)]);

  const received = await withTimeout(frames, 4_000);
  assert.deepEqual(
    received.filter((f) => f.id).map((f) => f.id),
    ["1", "2", "3", "4"],
  );
});

test("the stream stays open when run.end lands before an earlier seq, then delivers the rest in order", async () => {
  const { db, deps } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const store = createPgSandboxRunStore(db);
  const log = (seq: number) => ({
    seq,
    kind: "log",
    payload: { kind: "log", level: "info", message: `step ${seq}` },
  });
  await store.appendEvents(runId, [
    log(1),
    log(2),
    log(4),
    { seq: 5, kind: "run.end", payload: { status: "ok" } },
  ]);

  const res = await handleRunEvents(new Request("http://localhost/api"), PROJ, runId, {
    ...deps,
    pollIntervalMs: 50,
  });
  const frames = collectFrames(res.body!.getReader());
  await new Promise((r) => setTimeout(r, 400));
  await store.appendEvents(runId, [log(3)]);

  const received = await withTimeout(frames, 4_000);
  assert.deepEqual(
    received.filter((f) => f.id).map((f) => f.id),
    ["1", "2", "3", "4", "5"],
  );
  assert.deepEqual(received.at(-1), {
    id: undefined,
    event: "run.status",
    data: '{"status":"ok","error":null}',
  });
});

test("a gap that is never repaired ends the stream as lost, without the rows past it", async () => {
  const { client, db, deps } = await setup();
  const { runId } = (await (await handleStartRun(post(START), PROJ, deps)).json()) as {
    runId: string;
  };
  const store = createPgSandboxRunStore(db);
  await store.appendEvents(runId, [
    { seq: 1, kind: "log", payload: { kind: "log", level: "info", message: "step 1" } },
    { seq: 3, kind: "run.end", payload: { status: "ok" } },
  ]);
  const res = await handleRunEvents(new Request("http://localhost/api"), PROJ, runId, {
    ...deps,
    pollIntervalMs: 50,
  });
  const frames = collectFrames(res.body!.getReader());
  await new Promise((r) => setTimeout(r, 200));
  await client.exec(
    `update sandbox_runs set status = 'running', lease_at = now() - interval '61 seconds' where id = '${runId}'`,
  );
  await store.markLost(new Date());

  const received = await withTimeout(frames, 4_000);
  assert.deepEqual(
    received.filter((f) => f.id).map((f) => f.id),
    ["1"],
  );
  assert.equal(received.at(-1)?.event, "run.status");
  assert.match(received.at(-1)?.data ?? "", /"status":"lost"/);
});

const CHAT = {
  runnerId: MY_RUNNER,
  sandboxId: "docs-agent",
  input: { messages: [{ role: "user", content: "My search is broken, open a ticket" }] },
};

test("a sideEffect tool cannot run real unless the manifest allows it", async () => {
  const { deps } = await setup();
  const real = await handleStartRun(
    post({ ...CHAT, toolModes: { createTicket: "real" } }),
    PROJ,
    deps,
  );
  assert.equal(real.status, 400);
  const body = (await real.json()) as { error: string; message: string };
  assert.equal(body.error, "invalid_tool_modes");
  assert.match(body.message, /createTicket: real needs allowReal/);
  assert.equal(
    (
      await handleStartRun(
        post({ ...CHAT, toolModes: { createTicket: "confirm", searchDocs: "fake" } }),
        PROJ,
        deps,
      )
    ).status,
    201,
  );
  assert.equal(
    (await handleStartRun(post({ ...CHAT, toolModes: { nope: "fake" } }), PROJ, deps)).status,
    400,
  );
});

test("confirm queues tool.confirm.decision for a pending confirm call only, once", async () => {
  const { db, deps, tracked } = await setup();
  const { runId } = (await (
    await handleStartRun(post({ ...CHAT, toolModes: { createTicket: "confirm" } }), PROJ, deps)
  ).json()) as { runId: string };
  const confirm = (body: unknown) => handleConfirmTool(post(body), PROJ, runId, deps);

  assert.equal(
    (await confirm({ callId: "call_1", decision: "approve" })).status,
    409,
    "no such call yet",
  );
  await createPgSandboxRunStore(db).appendEvents(runId, [
    {
      seq: 1,
      kind: "tool.call",
      payload: {
        kind: "tool.call",
        callId: "call_1",
        tool: "createTicket",
        args: { title: "Search" },
        mode: "confirm",
      },
    },
    {
      seq: 2,
      kind: "tool.call",
      payload: {
        kind: "tool.call",
        callId: "call_2",
        tool: "searchDocs",
        args: { query: "x" },
        mode: "real",
      },
    },
  ]);
  assert.equal(
    (await confirm({ callId: "call_1", decision: "edit" })).status,
    400,
    "edit needs args",
  );
  assert.equal(
    (await confirm({ callId: "call_2", decision: "approve" })).status,
    409,
    "a real call is not a confirm",
  );
  assert.equal(
    (await confirm({ callId: "call_1", decision: "edit", args: { title: "Search is down" } }))
      .status,
    202,
  );
  assert.equal(
    (await confirm({ callId: "call_1", decision: "reject" })).status,
    409,
    "decided already",
  );

  const commands = (await db.select().from(sandboxCommands)).filter(
    (c) => c.kind === "tool.confirm.decision",
  );
  assert.deepEqual(
    commands.map((c) => c.payload),
    [{ callId: "call_1", decision: "edit", args: { title: "Search is down" } }],
  );
  assert.deepEqual(tracked, ["sandbox_run_started", "sandbox_tool_confirmed"]);
  assert.equal(
    (
      await handleConfirmTool(
        post({ callId: "call_1", decision: "approve" }),
        PROJ,
        "11111111-0000-4000-8000-000000000000",
        deps,
      )
    ).status,
    404,
  );
});

test("pin stores a fake value under the normalized arguments, only in the caller's own session", async () => {
  const { db, deps } = await setup();
  const { sessionId } = (await (await handleStartRun(post(CHAT), PROJ, deps)).json()) as {
    sessionId: string;
  };
  const res = await handlePinFake(
    post({ sessionId, tool: "createTicket", args: { b: 1, a: 2 }, result: { id: "T-9" } }),
    PROJ,
    deps,
  );
  assert.equal(res.status, 201);
  assert.deepEqual(
    await createPgFakeStore(db).pinned(sessionId, "createTicket", argsKey({ a: 2, b: 1 })),
    { result: { id: "T-9" }, isError: false },
  );

  await db.update(sandboxSessions).set({ ownerUserId: "user_them" });
  assert.equal(
    (
      await handlePinFake(
        post({ sessionId, tool: "createTicket", args: {}, result: 1 }),
        PROJ,
        deps,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handlePinFake(
        post({ sessionId: "nope", tool: "createTicket", args: {}, result: 1 }),
        PROJ,
        deps,
      )
    ).status,
    400,
  );
});

test("pins of a replay session answer its runs only: not another session, not another project", async () => {
  const { client, db, deps, tracked } = await setup();
  const replay = { sourceSessionId: "recorded-1", arm: "baseline" };
  const start = async (sessionId?: string) =>
    (await (
      await handleStartRun(
        post({
          ...CHAT,
          toolModes: { searchDocs: "fake" },
          replay,
          ...(sessionId ? { sessionId } : {}),
        }),
        PROJ,
        deps,
      )
    ).json()) as { runId: string; sessionId: string };
  const a = await start();
  const b = await start();
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(
    (
      await handlePinFake(
        post({
          sessionId: a.sessionId,
          tool: "searchDocs",
          args: { query: "keys" },
          result: { hits: ["pinned"] },
        }),
        PROJ,
        deps,
      )
    ).status,
    201,
  );

  // A second run in session A (the other arm, or Run again) gets the pin; a run in session B does not.
  const again = await start(a.sessionId);
  const service = createFakeService({
    store: createPgFakeStore(db),
    model: { generate: async () => ({ result: { generated: true }, state: {}, isError: false }) },
    alerts: { capReached: () => {} },
    dailyCap: 10,
  });
  const ask = (runId: string) =>
    service.answer({ runId, callId: "c", tool: "searchDocs", args: { query: "keys" } });
  const inA = await ask(again.runId);
  assert.deepEqual(inA.kind === "answer" ? [inA.answer.source, inA.answer.result] : null, [
    "pinned",
    { hits: ["pinned"] },
  ]);
  const inB = await ask(b.runId);
  assert.notEqual(inB.kind === "answer" ? inB.answer.source : null, "pinned");

  const list = (sessionId: string) =>
    handleListPins(new Request(`http://localhost/api?sessionId=${sessionId}`), PROJ, deps);
  const listed = (await (await list(a.sessionId)).json()) as {
    pins: { tool: string; args: unknown; result: unknown }[];
  };
  assert.deepEqual(
    listed.pins.map((p) => [p.tool, p.args, p.result]),
    [["searchDocs", { query: "keys" }, { hits: ["pinned"] }]],
  );
  assert.deepEqual(((await (await list(b.sessionId)).json()) as { pins: unknown[] }).pins, []);

  // Session A moved to another project: its pins are not reachable from this project.
  const OTHER = "55555555-5555-4555-8555-555555555555";
  await client.exec(
    `insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${ORG}', 'B', 'b')`,
  );
  await client.query(`update sandbox_sessions set project_id = $1 where id = $2`, [
    OTHER,
    a.sessionId,
  ]);
  assert.equal((await list(a.sessionId)).status, 404);
  const del = (body: unknown) =>
    handleUnpinFake(
      new Request("http://localhost/api", { method: "DELETE", body: JSON.stringify(body) }),
      PROJ,
      deps,
    );
  assert.equal(
    (await del({ sessionId: a.sessionId, tool: "searchDocs", args: { query: "keys" } })).status,
    404,
  );

  // Back in this project, remove works once.
  await client.query(`update sandbox_sessions set project_id = $1 where id = $2`, [
    PROJ,
    a.sessionId,
  ]);
  assert.equal(
    (await del({ sessionId: a.sessionId, tool: "searchDocs", args: { query: "keys" } })).status,
    200,
  );
  assert.equal(
    (await del({ sessionId: a.sessionId, tool: "searchDocs", args: { query: "keys" } })).status,
    404,
  );
  assert.deepEqual(((await (await list(a.sessionId)).json()) as { pins: unknown[] }).pins, []);
  assert.ok(tracked.includes("sandbox_fake_unpinned"));
});
