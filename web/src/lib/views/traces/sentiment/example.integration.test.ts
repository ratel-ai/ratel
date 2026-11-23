import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import {
  type Db,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import {
  EXAMPLE_MAX_ERROR_CHARS,
  loadTurnConversation,
  loadTurnExample,
} from "@/lib/views/traces/sentiment/example";

/**
 * One example turn read back from a migrated database: the steps with each
 * call's outcome and its error message, and, where the turn scope sent them,
 * the person's request and next message. Every message here is invented.
 */

const BASE = Date.parse("2026-09-01T09:00:00Z");
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    // A declared turn whose scope sent the request; the session goes on with a message that made no call.
    fresh({ session: "s-text", start: BASE, turnId: "turn-1" })
      .search(["find_task", "update_task"])
      .invoke("update_task")
      .error("update_task")
      .invoke("update_task"),
    // No turn scope: a project that sends no messages.
    fresh({ session: "s-plain", start: BASE + 60_000 })
      .invoke("send_report")
      .error("send_report"),
  ]);
  await client.query(
    `update trace_events set error_message = 'validation_failed' where type = 'invoke_error' and tool_id = 'update_task'`,
  );
  await client.query(
    `update trace_events set error_message = $1 where type = 'invoke_error' and tool_id = 'send_report'`,
    ["Internal server error ".repeat(40)],
  );
  const start = (session: string, turnId: string, at: number, message: string) =>
    client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, payload)
       values (gen_random_uuid(), $1, 'turn_start', $2, $3, $3, $4, jsonb_build_object('user_message', $5::text, 'turn_id', $6::text))`,
      [PROJECT_ID, session, new Date(at).toISOString(), `start-${turnId}`, message, turnId],
    );
  await start("s-text", "turn-1", BASE - 1_000, "mark the launch task done");
  await start("s-text", "turn-2", BASE + 30_000, "no, the other launch task");
  return { client, db };
}

const turnOf = async (client: PGlite, session: string): Promise<string> =>
  (
    await client.query<{ id: string }>(`select id from trace_turns where session_id = $1`, [
      session,
    ])
  ).rows[0]!.id;

test("a turn with messages: the request, the steps with the error, and the next message", async () => {
  const { client, db } = await seeded();
  const example = await loadTurnExample(
    db as unknown as BoundReadDb,
    PROJECT_ID,
    await turnOf(client, "s-text"),
  );

  assert.ok(example);
  assert.equal(example.sessionId, "s-text");
  assert.equal(example.text, true);
  assert.equal(example.request, "mark the launch task done");
  assert.equal(example.next, "no, the other launch task");
  assert.equal(example.reply, null, "no reply was captured");
  assert.deepEqual(
    example.steps.map((step) => [step.ordinal, step.kind, step.tool, step.outcome, step.error]),
    [
      [1, "search", null, null, null],
      [2, "invoke", "update_task", "error", "validation_failed"],
      [3, "invoke", "update_task", "ok", null],
    ],
  );
  assert.equal(example.steps[0]?.hits, 2);
  assert.equal(example.moreSteps, 0);
});

test("a project that sends no messages: steps and the error only, the error cut to a bounded length", async () => {
  const { client, db } = await seeded();
  const example = await loadTurnExample(
    db as unknown as BoundReadDb,
    PROJECT_ID,
    await turnOf(client, "s-plain"),
  );

  assert.ok(example);
  assert.deepEqual(
    [example.text, example.request, example.reply, example.next],
    [false, null, null, null],
  );
  assert.deepEqual(
    example.steps.map((step) => [step.tool, step.outcome]),
    [["send_report", "error"]],
  );
  const error = example.steps[0]?.error ?? "";
  assert.ok(error.startsWith("Internal server error"));
  assert.equal(error.length, EXAMPLE_MAX_ERROR_CHARS);
});

test("a turn is read only within its project", async () => {
  const { client, db } = await seeded();
  await client.exec(
    `insert into projects (id, organization_id, name, slug) select '${OTHER_PROJECT}', organization_id, 'Other', 'other' from projects limit 1`,
  );
  const turnId = await turnOf(client, "s-text");
  assert.equal(await loadTurnExample(db as unknown as BoundReadDb, OTHER_PROJECT, turnId), null);
  assert.equal(
    await loadTurnExample(
      db as unknown as BoundReadDb,
      PROJECT_ID,
      "44444444-4444-4444-8444-444444444444",
    ),
    null,
  );
});

test("a turn's conversation: the person's next message when one was sent; nothing to read is nothing shown", async () => {
  const { client, db } = await seeded();
  const read = (turnId: string) =>
    loadTurnConversation(db as unknown as BoundReadDb, PROJECT_ID, turnId);
  assert.deepEqual(await read(await turnOf(client, "s-text")), {
    request: "mark the launch task done",
    reply: null,
    next: { from: "person", text: "no, the other launch task" },
  });
  // No messages and no captured replies: nothing comes after to read.
  assert.deepEqual(await read(await turnOf(client, "s-plain")), {
    request: null,
    reply: null,
    next: null,
  });
  assert.equal(await read("44444444-4444-4444-8444-444444444444"), null);
});
