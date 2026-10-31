import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { StoredSelfCorrections } from "@/lib/readings/trace-signals/self-corrections/run";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun, listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * One signal run over a migrated database: the window's self-corrections are
 * written (behaviour and phrases in captured replies, joined by trace id and,
 * for rows stored before that existed, by the span-id dedupe hash), replaced
 * on the next run, placed in their task, and the `self_correcting` issues
 * join the run's signals. A failed reading never fails the run.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");
const TRACE = (i: number) => i.toString(16).padStart(32, "0");

/** 30 runs of find_task then update_task, each its own trace; the first 12 fail update_task once and retry it. */
function fixtures() {
  return times(30, (i) => {
    const run = fresh({
      lane: "otlp",
      traceId: TRACE(i + 1),
      session: `s-${i}`,
      start: BASE + i * 60_000,
    }).invoke("find_task");
    return i < 12
      ? run.invoke("update_task").error("update_task").invoke("update_task")
      : run.invoke("update_task");
  });
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "tool_call", id: "c", name: "update_task", arguments: {} },
  ],
});

async function insertCall(
  client: PGlite,
  call: {
    traceId: string | null;
    spanId: string | null;
    dedupeHash: string;
    atMs: number;
    messages: unknown[];
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into events (id, project_id, received_at, occurred_at, provider, model, payload, dedupe_hash, trace_id, span_id)
     values ($1, $2, $3, $3, 'anthropic', 'claude-x', $4::jsonb, $5, $6, $7)`,
    [
      id,
      PROJECT_ID,
      new Date(call.atMs).toISOString(),
      JSON.stringify({ provider: "anthropic", model: "claude-x", ts: "", messages: call.messages }),
      call.dedupeHash,
      call.traceId,
      call.spanId,
    ],
  );
  return id;
}

/** Run 0's reply, joined by trace id: an apology and a retry right after update_task failed (it failed at +3 s, retried at +4 s). */
async function exactReply(client: PGlite): Promise<string> {
  return insertCall(client, {
    traceId: TRACE(1),
    spanId: "00000000000000a1",
    dedupeHash: "resp-hash-1",
    atMs: BASE + 3_500,
    messages: [
      user("update the ticket"),
      assistant("I'm sorry, that failed. Let me try that again."),
    ],
  });
}

/** Run 1's reply, stored before events carried a trace id: found by its span id's hash. */
async function hashedReply(client: PGlite): Promise<string> {
  const spanId = "00000000000000b2";
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
     values ($1, $2, $3, $4, 'chat', 3, 'llm', $5, $5, 10, 0, '{}'::jsonb)`,
    [randomUUID(), PROJECT_ID, TRACE(2), spanId, new Date(BASE + 60_000 + 5_500).toISOString()],
  );
  return insertCall(client, {
    traceId: null,
    spanId: null,
    dedupeHash: createHash("sha256").update(spanId).digest("hex"),
    atMs: BASE + 60_000 + 5_500,
    messages: [user("update the ticket"), assistant("You're absolutely right, my mistake.")],
  });
}

interface Row {
  turn_id: string;
  kind: string;
  step_ordinal: number | null;
  tool_id: string | null;
  tool_outcome: string | null;
  recovered: boolean | null;
  workflow_id: string | null;
  phrase_category: string | null;
  phrase: string | null;
  source_event_id: string | null;
  match_start: number | null;
  match_end: number | null;
}

async function rows(client: PGlite): Promise<Row[]> {
  const result = await client.query<Row>(
    `select turn_id, kind, step_ordinal, tool_id, tool_outcome, recovered, workflow_id, phrase_category, phrase, source_event_id, match_start, match_end
     from trace_self_corrections where project_id = '${PROJECT_ID}' order by occurred_at, kind, phrase`,
  );
  return result.rows;
}

async function seeded(): Promise<{ client: PGlite; db: Db; exact: string; hashed: string }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  return { client, db, exact: await exactReply(client), hashed: await hashedReply(client) };
}

test("a run writes every self-correction, phrases from captured replies included, and finds the issue", async () => {
  const { client, db, exact, hashed } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");

  const written = await rows(client);
  const retries = written.filter((r) => r.kind === "retry_after_error");
  assert.equal(retries.length, 12);
  assert.ok(
    retries.every(
      (r) =>
        r.tool_id === "update_task" &&
        r.tool_outcome === "error" &&
        r.recovered === true &&
        r.step_ordinal === 2,
    ),
  );
  const phrases = written.filter((r) => r.kind === "phrase");
  assert.deepEqual(
    phrases.map((r) => [r.phrase_category, r.phrase, r.source_event_id, r.tool_id, r.tool_outcome]),
    [
      ["apology", "I'm sorry", exact, "update_task", "error"],
      ["retry", "Let me try that again", exact, "update_task", "error"],
      ["admission", "My mistake", hashed, "update_task", "ok"],
      ["concession", "You're absolutely right", hashed, "update_task", "ok"],
    ],
  );
  const sorry = phrases.find((r) => r.phrase === "I'm sorry")!;
  assert.deepEqual([sorry.match_start, sorry.match_end], [0, 9], "the range points into the reply");

  const run = await latestSignalRun(PROJECT_ID, db);
  const stored = (run?.summary as { selfCorrections?: StoredSelfCorrections }).selfCorrections;
  assert.deepEqual(stored, {
    version: 1,
    trust: { runs: "all", sessions: true },
    turns: 30,
    turnsWithReplies: 2,
    events: 16,
  });

  const issue = (await listOpenSignals(PROJECT_ID, db)).find(
    (s) => s.kind === "self_correcting" && s.subjectKey === "update_task",
  );
  assert.ok(issue, "update_task: 12 of 30 runs corrected after it");
  assert.equal(issue.subjectKind, "tool");
  assert.equal((issue.metrics as Record<string, unknown>).pattern, "failed");
  assert.equal((issue.metrics as Record<string, unknown>).route, "show_turns");
  assert.equal((issue.metrics as Record<string, unknown>).k, 12);
  await client.close();
});

test("no reply text is stored: rows keep the phrase, its category and a pointer", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const dump = await client.query<{ row: string }>(
    `select row_to_json(s)::text as row from trace_self_corrections s
     union all select row_to_json(g)::text from trace_signals g
     union all select row_to_json(r)::text from trace_signal_runs r`,
  );
  const text = dump.rows.map((r) => r.row).join("\n");
  assert.doesNotMatch(text, /that failed/);
  assert.doesNotMatch(text, /update the ticket/);
  await client.close();
});

test("the next run replaces the window's rows and reads each turn's task from the ledger", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const first = await rows(client);
  const run = await latestSignalRun(PROJECT_ID, db);
  const task = (run?.summary as { workflows?: { items: { id: string }[] } }).workflows?.items[0]
    ?.id;
  assert.ok(task, "the run mined find_task then update_task");
  // What the Tasks reading writes: each run's task.
  await client.query(`update trace_turns set workflow_id = $1 where project_id = $2`, [
    task,
    PROJECT_ID,
  ]);

  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 3_600_000)),
  );
  const second = await rows(client);
  assert.equal(second.length, first.length, "replaced, never duplicated");
  assert.ok(second.every((r) => r.workflow_id === task));
  const issues = (await listOpenSignals(PROJECT_ID, db)).filter(
    (s) => s.kind === "self_correcting",
  );
  const byTask = issues.find((s) => s.subjectKind === "workflow");
  assert.equal(byTask?.subjectKey, task);
  assert.equal((byTask?.metrics as Record<string, unknown>).fixTool, "update_task");
  await client.close();
});

test("a failed reading never fails the run, and leaves the issue unmeasured", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const before = (await listOpenSignals(PROJECT_ID, db)).filter(
    (s) => s.kind === "self_correcting",
  );
  assert.ok(before.length > 0);
  const broken = jobDeps(db, new Date(NOW.getTime() + 3_600_000), [], {
    recordSelfCorrections: async () => {
      throw new Error("boom");
    },
  });
  for (let i = 0; i < 3; i += 1) {
    const result = await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, broken);
    assert.equal(result.outcome, "completed");
  }
  const after = (await listOpenSignals(PROJECT_ID, db)).filter((s) => s.kind === "self_correcting");
  assert.equal(
    after.length,
    before.length,
    "three readings that could not see self-corrections resolve nothing",
  );
  assert.equal(
    await count(client, `select count(*)::int as n from trace_self_corrections`),
    16,
    "the window keeps its earlier rows",
  );
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.equal((run?.summary as { selfCorrections?: unknown }).selfCorrections, undefined);
  await client.close();
});
