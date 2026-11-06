import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { readSelfCorrectionsCard } from "@/lib/views/health/self-corrections/card";
import {
  exampleOf,
  loadExampleRow,
  loadReplyMessages,
} from "@/lib/views/health/self-corrections/example";
import { readSelfCorrectionsPage } from "@/lib/views/health/self-corrections/page-load";

/**
 * The page's reads over a database a signal run wrote: grouped counts with
 * and without filters, the issue's fix, examples without text, an example's
 * words read back from content capture, and the Summary card.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");
const TRACE = (i: number) => i.toString(16).padStart(32, "0");
const REPLY = "I'm sorry, that failed. Let me try that again.";

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(30, (i) => {
      const run = fresh({
        lane: "otlp",
        traceId: TRACE(i + 1),
        session: `s-${i}`,
        start: BASE + i * 60_000,
      }).invoke("find_task");
      return i < 12
        ? run.invoke("update_task").error("update_task").invoke("update_task")
        : run.invoke("update_task");
    }),
  );
  const messages = [
    { role: "user", content: [{ type: "text", text: "update the ticket" }] },
    { role: "assistant", content: [{ type: "text", text: REPLY }] },
  ];
  await client.query(
    `insert into events (id, project_id, received_at, occurred_at, payload, dedupe_hash, trace_id, span_id)
     values ($1, $2, $3, $3, $4::jsonb, 'h1', $5, '00000000000000a1')`,
    [
      randomUUID(),
      PROJECT_ID,
      new Date(BASE + 3_500).toISOString(),
      JSON.stringify({ messages }),
      TRACE(1),
    ],
  );
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  return { client, db };
}

test("the page reads what the run wrote: numbers, breakdowns, the fix and examples", async () => {
  const { client, db } = await seeded();
  const page = await readSelfCorrectionsPage(db, {
    projectId: PROJECT_ID,
    windowDays: 7,
    now: NOW,
  });
  assert.equal(page.state, "ready");
  assert.equal(page.turns, 30);
  assert.equal(page.events, 14, "12 retries and two phrases");
  assert.deepEqual(
    page.stats.slice(0, 2).map((s) => [s.label, s.value, s.hint]),
    [
      ["Per 100 turns", "46.7", "14 in 30 turns"],
      ["Recovered", "100%", "12 of 12 failed calls"],
    ],
  );
  assert.equal(page.byKind.find((row) => row.kind === "retried")?.events, 12);
  assert.equal(page.byKind.find((row) => row.kind === "apologized")?.events, 1);
  assert.equal(page.byKind.find((row) => row.kind === "backtracked")?.events, 1);
  assert.deepEqual(
    page.byTool.map((row) => [row.node, row.events, row.mainKind]),
    [["update_task", 14, "Retried after an error"]],
  );
  assert.deepEqual(
    page.phrases.top.map((row) => row.phrase),
    ["I'm sorry", "Let me try that again"],
  );
  assert.deepEqual(
    page.fixes.map((fix) => [fix.fix, fix.fixesHref]),
    [
      [
        "Make update_task fail with a clear message, or retry inside the tool.",
        "/project/11111111-1111-4111-8111-111111111111/improvement/fixes?tool=update_task",
      ],
    ],
  );
  assert.ok(page.examples.length > 0);
  assert.equal(page.examples[0]?.hasText, true, "a phrase with its reply still kept comes first");
  assert.ok(page.examples[0]?.traceHref.endsWith(`/traces/${TRACE(1)}`));
  const dump = JSON.stringify(page);
  assert.ok(!dump.includes("that failed"), "no reply text reaches the page model");
  await client.close();
});

test("filters narrow the rows and the turns they are counted against", async () => {
  const { client, db } = await seeded();
  const after = await readSelfCorrectionsPage(db, {
    projectId: PROJECT_ID,
    windowDays: 7,
    now: NOW,
    filters: { tool: "find_task", task: null, topic: null },
  });
  assert.equal(after.events, 0, "nothing followed find_task");
  assert.equal(after.turns, 30, "every run called find_task");
  const task = await readSelfCorrectionsPage(db, {
    projectId: PROJECT_ID,
    windowDays: 7,
    now: NOW,
    filters: { tool: null, task: "no-such-task", topic: null },
  });
  assert.equal(task.turns, 0);
  assert.equal(task.state, "no_turns");
  await client.close();
});

test("an example's words are read back from the captured reply, and an old one says it is gone", async () => {
  const { client, db } = await seeded();
  const rows = await client.query<{ id: string; phrase: string }>(
    `select id, phrase from trace_self_corrections where kind = 'phrase' order by match_start`,
  );
  const sorry = rows.rows.find((r) => r.phrase === "I'm sorry")!;
  const row = await loadExampleRow(db, PROJECT_ID, sorry.id);
  assert.ok(row?.sourceEventId);
  const reply = await loadReplyMessages(db, PROJECT_ID, row.sourceEventId);
  assert.deepEqual(exampleOf(row, reply), {
    ok: true,
    example: {
      state: "read",
      before: "",
      phrase: "I'm sorry",
      after: ", that failed. Let me try that again.",
    },
  });
  assert.equal(
    await loadExampleRow(db, "22222222-2222-4222-8222-222222222222", sorry.id),
    null,
    "another project cannot read it",
  );
  await client.query(`delete from events`);
  assert.deepEqual(exampleOf(row, await loadReplyMessages(db, PROJECT_ID, row.sourceEventId)), {
    ok: true,
    example: { state: "expired" },
  });
  await client.close();
});

test("the Summary row: rate, change and trend, recovered, the tool the agent corrects itself after most, the top phrase", async () => {
  const { client, db } = await seeded();
  const card = await readSelfCorrectionsCard(db, PROJECT_ID, 7, NOW);
  assert.equal(card.state, "ready");
  assert.equal(card.rate.value, "46.7");
  assert.equal(card.rate.delta, undefined, "no turns in the window before: no change to show");
  assert.deepEqual(card.topTool, {
    node: "update_task",
    entryId: "update_task",
    entryKind: "tool",
    name: "update_task",
    events: 14,
    mainKind: "Retried after an error",
    href: "/project/11111111-1111-4111-8111-111111111111/health/self-corrections?tool=update_task",
  });
  assert.equal(card.href, "/project/11111111-1111-4111-8111-111111111111/health/self-corrections");
  assert.equal(card.trend?.values.length, 7, "a day per bucket");
  assert.equal(
    card.trend?.values.filter((value) => value !== null).length && true,
    true,
    "read from the turns' days",
  );
  const page = await readSelfCorrectionsPage(db, {
    projectId: PROJECT_ID,
    windowDays: 7,
    now: NOW,
  });
  assert.deepEqual(card.trend, page.trend, "the row and the page draw the same trend");
  assert.equal(card.recovered?.label, "Recovered");
  assert.equal(card.recovered?.value, page.stats[1]?.value);
  assert.equal(card.phrasesCaptured, page.phrases.captured);
  assert.deepEqual(
    card.topPhrase,
    page.phrases.top[0]
      ? { phrase: page.phrases.top[0].phrase, events: page.phrases.top[0].events }
      : null,
  );
  await client.close();
});

test("before any reading the page and the card say so", async () => {
  const { client, db } = await setupDb();
  const page = await readSelfCorrectionsPage(db, {
    projectId: PROJECT_ID,
    windowDays: 7,
    now: NOW,
  });
  assert.equal(page.state, "not_read");
  assert.equal((await readSelfCorrectionsCard(db, PROJECT_ID, 7, NOW)).state, "not_read");
  await client.close();
});
