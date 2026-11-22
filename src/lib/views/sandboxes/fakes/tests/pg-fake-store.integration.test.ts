import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createPgSandboxRunStore, type SandboxDb } from "../../adapters/pg-store";
import { createPgFakeStore } from "../adapters/pg-fake-store";
import { argsKey, matchRecorded } from "../domain/fake";

/**
 * The fake store against real PGlite: pins per session, recorded calls from
 * the session's events and the replay source's spans with key order ignored,
 * production examples without fakes, the ledger and the daily count.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const RUNNER = "33333333-3333-4333-8333-333333333333";
const OWNER = "user_owner";

async function setup(): Promise<{ client: PGlite; db: SandboxDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
    insert into sandbox_runners (id, project_id, owner_user_id, instance_id, gateway_id) values ('${RUNNER}', '${PROJ}', '${OWNER}', 'rnr', 'gw_test1');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as SandboxDb };
}

async function startRun(
  db: SandboxDb,
  extra: { sessionId?: string; replay?: { sourceTraceId?: string; sourceSessionId?: string } } = {},
) {
  const result = await createPgSandboxRunStore(db).startRun({
    projectId: PROJ,
    ownerUserId: OWNER,
    runnerId: RUNNER,
    sandboxId: "docs-agent",
    input: { messages: [{ role: "user", content: "hi" }] },
    params: {},
    toolModes: { createTicket: "fake" },
    context: {},
    configHash: "a".repeat(64),
    overrides: [],
    ...extra,
  });
  assert.ok(result.ok);
  return result;
}

async function insertSpan(
  client: PGlite,
  attrs: Record<string, unknown>,
  opts: {
    traceId?: string;
    statusCode?: number;
    startedAt?: string;
    spanId?: string;
    parentSpanId?: string;
  } = {},
) {
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, operation_name, attributes)
     values ($1, $2, $3, $4, $8, 'execute_tool createTicket', 1, 'tool', $5, $5, 1, $6, 'execute_tool', $7)`,
    [
      randomUUID(),
      PROJ,
      opts.traceId ?? "trace-prod",
      opts.spanId ?? randomUUID().slice(0, 16),
      opts.startedAt ?? new Date().toISOString(),
      opts.statusCode ?? 0,
      JSON.stringify(attrs),
      opts.parentSpanId ?? null,
    ],
  );
}

const span = (args: unknown, result: unknown, extra: Record<string, unknown> = {}) => ({
  "gen_ai.operation.name": "execute_tool",
  "gen_ai.tool.name": "createTicket",
  "gen_ai.tool.call.arguments": JSON.stringify(args),
  "gen_ai.tool.call.result": JSON.stringify(result),
  ...extra,
});

test("run context carries the project, its organization, the session, the input and the replay source", async () => {
  const { db } = await setup();
  const run = await startRun(db, {
    replay: { sourceTraceId: "trace-src", sourceSessionId: "conv-src" },
  });
  const context = await createPgFakeStore(db).runContext(run.runId);
  assert.deepEqual(context, {
    runId: run.runId,
    projectId: PROJ,
    organizationId: ORG,
    sessionId: run.sessionId,
    input: { messages: [{ role: "user", content: "hi" }] },
    replay: { sourceTraceId: "trace-src", sourceSessionId: "conv-src" },
  });
  assert.equal(await createPgFakeStore(db).runContext(randomUUID()), null);
});

test("a pin is per session, tool and normalized arguments, and a new pin replaces the old one", async () => {
  const { db } = await setup();
  const run = await startRun(db);
  const store = createPgFakeStore(db);
  const key = argsKey({ b: 1, a: 2 });
  await store.pin({
    sessionId: run.sessionId,
    tool: "createTicket",
    argsKey: key,
    result: { id: "T-1" },
    isError: false,
    pinnedBy: OWNER,
  });
  await store.pin({
    sessionId: run.sessionId,
    tool: "createTicket",
    argsKey: key,
    result: { id: "T-2" },
    isError: false,
    pinnedBy: OWNER,
  });
  assert.deepEqual(await store.pinned(run.sessionId, "createTicket", argsKey({ a: 2, b: 1 })), {
    result: { id: "T-2" },
    isError: false,
  });
  assert.equal(await store.pinned(run.sessionId, "searchDocs", key), null);
});

test("recorded calls: real and approved session calls match regardless of key order; fakes and rejects never", async () => {
  const { db } = await setup();
  const run = await startRun(db);
  const runs = createPgSandboxRunStore(db);
  const call = (seq: number, callId: string, args: unknown, mode: string) => ({
    seq,
    kind: "tool.call",
    payload: { kind: "tool.call", callId, tool: "createTicket", args, mode },
  });
  const result = (
    seq: number,
    callId: string,
    value: unknown,
    mode: string,
    extra: Record<string, unknown> = {},
  ) => ({
    seq,
    kind: "tool.result",
    payload: { kind: "tool.result", callId, result: value, isError: false, mode, ...extra },
  });
  await runs.appendEvents(run.runId, [
    call(1, "c_real", { title: "Down", priority: "high" }, "real"),
    result(2, "c_real", { id: "T-REAL" }, "real"),
    call(3, "c_fake", { title: "Fake one" }, "fake"),
    result(4, "c_fake", { id: "T-FAKE" }, "fake", { fakeSource: "generated" }),
    call(5, "c_ok", { title: "Approved" }, "confirm"),
    result(6, "c_ok", { id: "T-OK" }, "confirm", { confirmDecision: "approve" }),
    call(7, "c_no", { title: "Rejected" }, "confirm"),
    result(8, "c_no", { error: "Rejected by reviewer" }, "confirm", { confirmDecision: "reject" }),
  ]);
  const calls = await createPgFakeStore(db).recordedCalls({
    projectId: PROJ,
    sessionId: run.sessionId,
    tool: "createTicket",
    replay: null,
  });
  assert.deepEqual(
    calls.map((c) => c.result).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [{ id: "T-OK" }, { id: "T-REAL" }],
  );
  assert.deepEqual(matchRecorded(calls, { priority: "high", title: "Down" })?.result, {
    id: "T-REAL",
  });
  assert.equal(matchRecorded(calls, { title: "Fake one" }), null);
});

test("recorded calls from the replay source: its trace or its conversation, never a fake span", async () => {
  const { client, db } = await setup();
  const run = await startRun(db, {
    replay: { sourceTraceId: "trace-src", sourceSessionId: "conv-src" },
  });
  await insertSpan(client, span({ title: "A", tags: ["x"] }, { id: "T-A" }), {
    traceId: "trace-src",
  });
  await insertSpan(
    client,
    span({ title: "B" }, { id: "T-B" }, { "gen_ai.conversation.id": "conv-src" }),
    { traceId: "trace-other" },
  );
  await insertSpan(client, span({ title: "C" }, { id: "T-C" }, { "ratel.tool.mode": "fake" }), {
    traceId: "trace-src",
  });
  await insertSpan(client, span({ title: "D" }, { id: "T-D" }), { traceId: "unrelated" });
  const store = createPgFakeStore(db);
  const context = (await store.runContext(run.runId))!;
  const calls = await store.recordedCalls({
    projectId: PROJ,
    sessionId: run.sessionId,
    tool: "createTicket",
    replay: context.replay,
  });
  assert.deepEqual(
    calls.map((c) => c.result).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [{ id: "T-A" }, { id: "T-B" }],
  );
  assert.deepEqual(matchRecorded(calls, { tags: ["x"], title: "A" })?.result, { id: "T-A" });
});

test("production examples leave out fake spans (also the framework span of a fake call), playground spans, old spans and spans with no result", async () => {
  const { client, db } = await setup();
  await insertSpan(client, span({ title: "real" }, { id: "T-1" }));
  await insertSpan(client, span({ title: "error" }, { error: "bad" }), { statusCode: 2 });
  await insertSpan(client, span({ title: "fake" }, { id: "T-F" }, { "ratel.tool.mode": "fake" }));
  await insertSpan(client, span({ title: "old" }, { id: "T-OLD" }), {
    startedAt: "2020-01-01T00:00:00Z",
  });
  await insertSpan(client, {
    "gen_ai.tool.name": "createTicket",
    "gen_ai.tool.call.arguments": "{}",
  });
  // The AI SDK's own span of a faked call: the result, no mode, and the runner's fake span as its child.
  await insertSpan(client, span({ title: "framework" }, { id: "T-SDK" }), {
    traceId: "trace-pg",
    spanId: "aaaa000000000001",
  });
  await insertSpan(
    client,
    { "gen_ai.tool.name": "createTicket", "ratel.tool.mode": "fake" },
    { traceId: "trace-pg", spanId: "aaaa000000000002", parentSpanId: "aaaa000000000001" },
  );
  // A real call made in the playground: not production.
  await insertSpan(
    client,
    span({ title: "playground" }, { id: "T-PG" }, { "deployment.environment.name": "playground" }),
  );
  const examples = await createPgFakeStore(db).productionExamples(PROJ, "createTicket");
  assert.deepEqual(
    examples
      .map((e) => [e.result, e.isError])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [
      [{ error: "bad" }, true],
      [{ id: "T-1" }, false],
    ],
  );
});

test("the ledger is one object per session, and the daily count goes up per project and day", async () => {
  const { db } = await setup();
  const run = await startRun(db);
  const store = createPgFakeStore(db);
  assert.deepEqual(await store.ledger(run.sessionId), {});
  await store.saveLedger(run.sessionId, { tickets: [{ id: "T-9" }] });
  assert.deepEqual(await store.ledger(run.sessionId), { tickets: [{ id: "T-9" }] });
  assert.deepEqual(
    [
      await store.countGenerated(PROJ, "2026-11-20"),
      await store.countGenerated(PROJ, "2026-11-20"),
      await store.countGenerated(PROJ, "2026-11-21"),
    ],
    [1, 2, 1],
  );
});
