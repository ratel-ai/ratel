import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createPgSandboxRunStore, type SandboxDb } from "@/lib/views/sandboxes/adapters/pg-store";
import { gatewayChannel, runChannel } from "@/lib/views/sandboxes/domain/channels";
import type { RunStartRequest } from "@/lib/views/sandboxes/domain/command";
import * as schema from "@/lib/views/sandboxes/schema";
import { sandboxCommands, sandboxRuns } from "@/lib/views/sandboxes/schema";

/**
 * The sandbox run store against real PGlite: the run and its command land together
 * and wake the gateway, a run goes only to its owner's runner, resent events are
 * stored once, readers see rows in seq order, silent runs go lost and old event
 * rows expire.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const RUNNER = "33333333-3333-4333-8333-333333333333";
const OFFLINE_RUNNER = "44444444-4444-4444-8444-444444444444";
const OWNER = "user_owner";
const GATEWAY = "gw_test1";
const HASH = "a".repeat(64);

async function setup(): Promise<{ client: PGlite; db: SandboxDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
    insert into sandbox_runners (id, project_id, owner_user_id, instance_id, gateway_id) values
      ('${RUNNER}', '${PROJ}', '${OWNER}', 'rnr_mbp', '${GATEWAY}'),
      ('${OFFLINE_RUNNER}', '${PROJ}', '${OWNER}', 'rnr_old', null);
  `);
  return { client, db: drizzle(client, { schema }) as unknown as SandboxDb };
}

function startRequest(overrides: Partial<RunStartRequest> = {}): RunStartRequest {
  return {
    projectId: PROJ,
    ownerUserId: OWNER,
    runnerId: RUNNER,
    sandboxId: "workflow-label",
    input: { workflowId: "wf_1", toolOrder: ["search"] },
    params: { maxTokens: 300 },
    toolModes: {},
    context: {},
    configHash: HASH,
    overrides: ["maxTokens"],
    ...overrides,
  };
}

async function startedRun(db: SandboxDb): Promise<string> {
  const result = await createPgSandboxRunStore(db).startRun(startRequest());
  assert.ok(result.ok);
  return result.runId;
}

function events(...seqs: number[]) {
  return seqs.map((seq) => ({
    seq,
    kind: "text.delta",
    payload: { kind: "text.delta", text: `t${seq}` },
  }));
}

test("startRun inserts the run and its run.start command, then wakes the gateway", async () => {
  const { client, db } = await setup();
  const woken: string[] = [];
  await client.listen(gatewayChannel(GATEWAY), (payload) => woken.push(payload));

  const result = await createPgSandboxRunStore(db).startRun(startRequest());

  assert.ok(result.ok);
  assert.equal(result.gatewayId, GATEWAY);
  const [run] = await db.select().from(sandboxRuns);
  assert.equal(run?.status, "queued");
  assert.equal(run?.sessionId, result.sessionId);
  const [command] = await db.select().from(sandboxCommands);
  assert.equal(command?.kind, "run.start");
  assert.equal(command?.gatewayId, GATEWAY);
  assert.equal(command?.ackedAt, null);
  assert.deepEqual((command?.payload as { params: unknown }).params, { maxTokens: 300 });
  assert.deepEqual(
    woken.map((p) => JSON.parse(p)),
    [{ runId: result.runId }],
  );
});

test("startRun refuses a runner that is not the owner's, and an offline one", async () => {
  const { db } = await setup();
  const store = createPgSandboxRunStore(db);

  assert.deepEqual(await store.startRun(startRequest({ ownerUserId: "user_other" })), {
    ok: false,
    reason: "runner_not_owner",
  });
  assert.deepEqual(await store.startRun(startRequest({ runnerId: OFFLINE_RUNNER })), {
    ok: false,
    reason: "runner_offline",
  });
  assert.deepEqual(
    await store.startRun(startRequest({ projectId: "55555555-5555-4555-8555-555555555555" })),
    { ok: false, reason: "runner_not_found" },
  );
  assert.equal((await db.select().from(sandboxRuns)).length, 0, "no run is stored");
  assert.equal((await db.select().from(sandboxCommands)).length, 0, "no command is sent");
});

test("startRun keeps a session only for its owner and sandbox", async () => {
  const { db } = await setup();
  const store = createPgSandboxRunStore(db);
  const first = await store.startRun(startRequest());
  assert.ok(first.ok);

  const again = await store.startRun(startRequest({ sessionId: first.sessionId }));
  assert.ok(again.ok);
  assert.equal(again.sessionId, first.sessionId);
  assert.deepEqual(
    await store.startRun(startRequest({ sessionId: first.sessionId, sandboxId: "topic-place" })),
    { ok: false, reason: "session_not_owner" },
  );
});

test("appendEvents stores a resent seq once and acks the highest seq with no gap", async () => {
  const { client, db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  const woken: string[] = [];
  await client.listen(runChannel(runId), (payload) => woken.push(payload));

  assert.deepEqual(await store.appendEvents(runId, events(1, 2)), { ackedSeq: 2 });
  assert.deepEqual(
    await store.appendEvents(runId, events(4)),
    { ackedSeq: 2 },
    "a gap holds the ack back",
  );
  assert.deepEqual(
    await store.appendEvents(runId, events(1, 2, 3, 4)),
    { ackedSeq: 4 },
    "sending the events again fills the gap",
  );

  const rows = await store.readEventsAfter(runId, 0);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [1, 2, 3, 4],
    "each seq once, in order",
  );
  assert.equal(rows[0]?.payload.text, "t1", "the first stored copy stays");
  assert.deepEqual(
    woken.map((p) => JSON.parse(p)),
    [{ seq: 2 }, { seq: 2 }, { seq: 4 }],
    "the notify carries the seq only",
  );
});

test("readEventsAfter resumes after the reader's last seq in seq order", async () => {
  const { db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  await store.appendEvents(runId, events(3, 1, 5, 2, 4));

  assert.deepEqual(
    (await store.readEventsAfter(runId, 2)).map((r) => r.seq),
    [3, 4, 5],
  );
  assert.deepEqual(
    (await store.readEventsAfter(runId, 0, 2)).map((r) => r.seq),
    [1, 2],
  );
  assert.deepEqual(await store.readEventsAfter(runId, 5), []);
});

test("a run.end event ends the run with its status, output and trace id", async () => {
  const { db } = await setup();
  const runId = await startedRun(db);
  await createPgSandboxRunStore(db).appendEvents(runId, [
    ...events(1),
    {
      seq: 2,
      kind: "run.end",
      payload: {
        status: "ok",
        output: { name: "Refunds" },
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    },
  ]);

  const [run] = await db.select().from(sandboxRuns).where(eq(sandboxRuns.id, runId));
  assert.equal(run?.status, "ok");
  assert.deepEqual(run?.output, { name: "Refunds" });
  assert.equal(run?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.ok(run?.endedAt);
});

test("cancelRun sends run.cancel to the gateway of a live run, and only for its owner", async () => {
  const { db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);

  assert.deepEqual(await store.cancelRun({ runId, projectId: PROJ, ownerUserId: "user_other" }), {
    ok: false,
    reason: "run_not_found",
  });
  assert.deepEqual(
    await store.cancelRun({ runId, projectId: PROJ, ownerUserId: OWNER, reason: "stop" }),
    { ok: true, status: "queued" },
  );
  const commands = await db
    .select()
    .from(sandboxCommands)
    .where(eq(sandboxCommands.kind, "run.cancel"));
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]?.payload, { reason: "stop" });
});

test("markLost ends live runs with no lease for 60 s and leaves leased ones", async () => {
  const { client, db } = await setup();
  const silent = await startedRun(db);
  const leased = await startedRun(db);
  await client.exec(`
    update sandbox_runs set status = 'running', started_at = now() - interval '5 minutes', lease_at = now() - interval '61 seconds' where id = '${silent}';
    update sandbox_runs set status = 'running', started_at = now() - interval '5 minutes', lease_at = now() - interval '10 seconds' where id = '${leased}';
  `);

  assert.deepEqual(await createPgSandboxRunStore(db).markLost(new Date()), [silent]);
  const rows = await db.select().from(sandboxRuns);
  const status = new Map(rows.map((r) => [r.id, r.status]));
  assert.equal(status.get(silent), "lost");
  assert.equal(status.get(leased), "running");
});

test("pruneExpiredEvents deletes event rows of runs that ended over 7 days ago", async () => {
  const { client, db } = await setup();
  const old = await startedRun(db);
  const recent = await startedRun(db);
  const live = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  for (const runId of [old, recent, live]) await store.appendEvents(runId, events(1, 2));
  await client.exec(`
    update sandbox_runs set status = 'ok', ended_at = now() - interval '8 days' where id = '${old}';
    update sandbox_runs set status = 'ok', ended_at = now() - interval '6 days' where id = '${recent}';
  `);

  assert.equal(await store.pruneExpiredEvents(new Date()), 2);
  assert.deepEqual(await store.readEventsAfter(old, 0), []);
  assert.equal((await store.readEventsAfter(recent, 0)).length, 2);
  assert.equal((await store.readEventsAfter(live, 0)).length, 2);
  assert.equal((await db.select().from(sandboxRuns)).length, 3, "the runs stay");
});

test("readEventsAfter returns only the contiguous prefix; repaired rows follow once, in order", async () => {
  const { db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  await store.appendEvents(runId, events(1, 2, 4));

  const first = await store.readEventsAfter(runId, 0);
  assert.deepEqual(
    first.map((r) => r.seq),
    [1, 2],
    "nothing past the gap",
  );
  assert.deepEqual(await store.readEventsAfter(runId, 2), [], "the reader waits at the gap");

  await store.appendEvents(runId, events(3));
  assert.deepEqual(
    (await store.readEventsAfter(runId, 2)).map((r) => r.seq),
    [3, 4],
  );
});

test("run.end past a gap does not end the run until the gap is repaired", async () => {
  const { db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  const status = async () =>
    (await db.select().from(sandboxRuns).where(eq(sandboxRuns.id, runId)))[0]?.status;
  await store.appendEvents(runId, [
    ...events(1, 2),
    { seq: 4, kind: "run.end", payload: { status: "ok" } },
  ]);
  assert.equal(await status(), "queued", "the end is stored but not applied");

  await store.appendEvents(runId, events(3));
  assert.equal(await status(), "ok");
});

test("a gap that is never repaired ends the run as lost", async () => {
  const { client, db } = await setup();
  const runId = await startedRun(db);
  const store = createPgSandboxRunStore(db);
  await store.appendEvents(runId, [
    ...events(1),
    { seq: 3, kind: "run.end", payload: { status: "ok" } },
  ]);
  await client.exec(
    `update sandbox_runs set status = 'running', lease_at = now() - interval '61 seconds' where id = '${runId}'`,
  );

  assert.deepEqual(await store.markLost(new Date()), [runId]);
  assert.deepEqual(
    (await store.readEventsAfter(runId, 0)).map((r) => r.seq),
    [1],
    "the reader never gets seq 3",
  );
});

test("listRuns returns the owner's runs of one sandbox, newest first, with their end fields", async () => {
  const { db } = await setup();
  const store = createPgSandboxRunStore(db);
  const first = await store.startRun(startRequest());
  assert.ok(first.ok);
  await store.appendEvents(first.runId, [
    {
      seq: 1,
      kind: "run.end",
      payload: {
        status: "ok",
        output: { name: "Refunds" },
        usage: { inputTokens: 10, outputTokens: 4 },
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    },
  ]);
  const second = await store.startRun(
    startRequest({ sessionId: first.sessionId, params: {}, overrides: [] }),
  );
  assert.ok(second.ok);
  await store.startRun(startRequest({ sandboxId: "topic-place" }));
  const theirs = await store.startRun(startRequest());
  assert.ok(theirs.ok);
  await db
    .update(sandboxRuns)
    .set({ ownerUserId: "user_other" })
    .where(eq(sandboxRuns.id, theirs.runId));
  await db
    .update(sandboxRuns)
    .set({ createdAt: new Date("2026-11-20T10:00:00Z") })
    .where(eq(sandboxRuns.id, first.runId));
  await db
    .update(sandboxRuns)
    .set({ createdAt: new Date("2026-11-20T11:00:00Z") })
    .where(eq(sandboxRuns.id, second.runId));

  const runs = await store.listRuns({
    projectId: PROJ,
    ownerUserId: OWNER,
    sandboxId: "workflow-label",
  });

  assert.deepEqual(
    runs.map((r) => r.id),
    [second.runId, first.runId],
  );
  const done = runs[1]!;
  assert.equal(done.status, "ok");
  assert.equal(done.sessionId, first.sessionId);
  assert.deepEqual(done.overrides, ["maxTokens"]);
  assert.deepEqual(done.params, { maxTokens: 300 });
  assert.deepEqual(done.input, { workflowId: "wf_1", toolOrder: ["search"] });
  assert.deepEqual(done.output, { name: "Refunds" });
  assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 4 });
  assert.equal(done.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.ok(done.endedAt instanceof Date);
  assert.equal(runs[0]!.status, "queued");
});

test("listRuns caps the list at the limit", async () => {
  const { db } = await setup();
  const store = createPgSandboxRunStore(db);
  for (let i = 0; i < 3; i++) assert.ok((await store.startRun(startRequest())).ok);

  assert.equal(
    (
      await store.listRuns({
        projectId: PROJ,
        ownerUserId: OWNER,
        sandboxId: "workflow-label",
        limit: 2,
      })
    ).length,
    2,
  );
  assert.equal(
    (await store.listRuns({ projectId: PROJ, ownerUserId: OWNER, sandboxId: "workflow-label" }))
      .length,
    3,
  );
});
