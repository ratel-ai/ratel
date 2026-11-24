import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { scorerSweepStep } from "./register";
import { createScorer, latestScores } from "./store";
import { type SweepOptions, sweepScorers } from "./sweep";
import { checkDraft } from "./test-support";
import { countMatchingTraces } from "./traces";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const on: SweepOptions = { flagOn: async () => true };

test("a trace is scored once, only after its summary settled", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const id = await scorer(client, db);
    await add("settled", { ageS: 60 });
    await add("fresh", { ageS: 10 });
    const first = await sweepScorers(on, db);
    assert.deepEqual([first.scoresWritten, first.caughtUp], [1, true]);
    assert.deepEqual(await scored(id), ["settled"]);

    await client.exec("update otel_trace_summaries set updated_at = now() - interval '50 seconds'");
    await sweepScorers(on, db);
    assert.deepEqual(await scored(id), ["fresh", "settled"]);
    // A summary written again (a late span) does not change the stored result.
    await client.exec(
      "update otel_trace_summaries set duration_ms = 9999, updated_at = now() - interval '46 seconds'",
    );
    const again = await sweepScorers(on, db);
    assert.deepEqual([again.tracesScanned, again.scoresWritten], [2, 0]);
    assert.ok((await latestScores(PROJECT, id, 10, db)).every((row) => row.passed));
  } finally {
    await client.close();
  }
});

test("the filter, the sample and the creation time limit the traces; a second sweep adds nothing", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const filtered = await scorer(client, db, { filter: { models: ["gpt-a"] } });
    const sampled = await scorer(client, db, { sampleRate: 50 });
    for (let n = 0; n < 400; n++)
      await add(`t${n}`, { ageS: 60, models: n < 10 ? ["gpt-a"] : ["gpt-b"] });
    await add("old", { ageS: 60, receivedAgeS: 7200, models: ["gpt-a"] });
    await add("other", { ageS: 60, project: OTHER_PROJECT, models: ["gpt-a"] });

    await sweepScorers({ ...on, batchSize: 37 }, db);
    assert.equal((await scored(filtered)).length, 10);
    const taken = await scored(sampled);
    assert.ok(taken.length > 160 && taken.length < 240, `${taken.length} of 400`);

    await client.exec("update trace_scorers set cursor_at = now() - interval '1 hour'");
    const second = await sweepScorers(on, db);
    assert.ok(second.tracesScanned > 0);
    assert.equal(second.scoresWritten, 0);
    assert.deepEqual(await scored(sampled), taken);
  } finally {
    await client.close();
  }
});

test("a root attribute is read, and a missing one is skipped", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const id = await scorer(client, db, {
      config: { path: "attributes.user.plan", op: "eq", value: "pro" },
    });
    await add("with", { ageS: 60, attributes: { "user.plan": "pro" } });
    await add("without", { ageS: 60, attributes: {} });
    const result = await sweepScorers(on, db);
    assert.deepEqual([result.scoresWritten, result.skipped], [1, 1]);
    assert.deepEqual(await scored(id), ["with"]);
  } finally {
    await client.close();
  }
});

test("a scorer scoped to a task scores only the traces of that task's turns, once each turn has its task", async () => {
  const { client, db, add, scored, turn, reading } = await setup();
  try {
    const scoped = await scorer(client, db, { filter: { taskId: "task-a" } });
    const all = await scorer(client, db);
    for (const id of ["otlp-a", "steps-a", "otlp-b", "no-task", "no-turn"])
      await add(id, { ageS: 7200, receivedAgeS: 60 });
    await add("other", { ageS: 7200, receivedAgeS: 60, project: OTHER_PROJECT });
    await client.exec(
      "update trace_scorers set cursor_at = now() - interval '3 hours'; update trace_scorers set created_at = now() - interval '3 hours'",
    );
    await turn({ key: "otlp:otlp-a" });
    await turn({ key: "declared:1", stepTraces: ["steps-a"] });
    await turn({ key: "otlp:otlp-b" });
    await turn({ key: "otlp:no-task" });
    await turn({ key: "otlp:other", project: OTHER_PROJECT });

    // No turn has a task before a signal run: the scoped scorer waits and loses nothing.
    await sweepScorers(on, db);
    assert.deepEqual(await scored(scoped), []);
    assert.equal((await scored(all)).length, 5);

    await client.exec(`
      update trace_turns set workflow_id = 'task-a' where turn_key in ('otlp:otlp-a', 'declared:1', 'otlp:other');
      update trace_turns set workflow_id = 'task-b' where turn_key = 'otlp:otlp-b';
    `);
    await reading();
    await sweepScorers(on, db);
    assert.deepEqual(await scored(scoped), ["otlp-a", "steps-a"]);

    // A trace that the last run did not place yet waits for the next one.
    await add("late", { ageS: 60 });
    await turn({ key: "otlp:late" });
    await sweepScorers(on, db);
    await client.exec("update trace_turns set workflow_id = 'task-a' where turn_key = 'otlp:late'");
    await sweepScorers(on, db);
    assert.deepEqual(await scored(scoped), ["otlp-a", "steps-a"]);
    await client.exec(
      "update otel_trace_summaries set updated_at = now() - interval '2 hours' where trace_id = 'late'; update trace_scorers set cursor_at = now() - interval '3 hours'",
    );
    await sweepScorers(on, db);
    assert.deepEqual(await scored(scoped), ["late", "otlp-a", "steps-a"]);
    assert.equal(await countMatchingTraces(PROJECT, { taskId: "task-a" }, new Date(0), db), 3);
  } finally {
    await client.close();
  }
});

test("a sweep stops at its time budget and the next one continues from the cursor", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const id = await scorer(client, db);
    for (let n = 0; n < 10; n++) await add(`t${n}`, { ageS: 60 });
    let clock = 0;
    const tick = () => {
      clock += 10;
      return clock;
    };
    const limited = { ...on, batchSize: 3, timeBudgetMs: 20, now: tick };
    const first = await sweepScorers(limited, db);
    assert.deepEqual([first.tracesScanned, first.caughtUp], [3, false]);
    assert.equal((await scored(id)).length, 3);
    const rest = await sweepScorers({ ...on, batchSize: 3 }, db);
    assert.deepEqual([rest.tracesScanned, rest.caughtUp], [7, true]);
    assert.equal((await scored(id)).length, 10);
  } finally {
    await client.close();
  }
});

test("with the flag off, or the scorer disabled, nothing is written and no cursor moves", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const id = await scorer(client, db);
    const disabled = await scorer(client, db, { enabled: false });
    await add("t", { ageS: 60 });
    const before = await client.query("select id, cursor_at from trace_scorers order by id");
    const result = await sweepScorers({ flagOn: async () => false }, db);
    assert.deepEqual([result.scorers, result.tracesScanned], [0, 0]);
    assert.deepEqual(
      (await client.query("select id, cursor_at from trace_scorers order by id")).rows,
      before.rows,
    );
    await sweepScorers(on, db);
    assert.equal((await scored(id)).length, 1);
    assert.equal((await scored(disabled)).length, 0);
  } finally {
    await client.close();
  }
});

test("one scorer that fails does not stop the others", async () => {
  const { client, db, add, scored } = await setup();
  try {
    const bad = await scorer(client, db, { name: "bad" });
    const good = await scorer(client, db);
    await add("t", { ageS: 60 });
    await client.exec(`
      create function refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$;
      create trigger refuse before insert on trace_scores for each row when (new.scorer_id = '${bad}') execute function refuse();
    `);
    const result = await sweepScorers(on, db);
    assert.equal(result.failedScorers, 1);
    assert.deepEqual([await scored(bad), await scored(good)], [[], ["t"]]);
  } finally {
    await client.close();
  }
});

test("the step emits one event per sweep that did work", async () => {
  const events: string[] = [];
  const track = async (event: string) => {
    events.push(event);
  };
  const idle = {
    scorers: 1,
    tracesScanned: 0,
    scoresWritten: 0,
    skipped: 0,
    failedScorers: 0,
    budgetSkips: [],
    caughtUp: true,
    lockContended: false,
  };
  const step = scorerSweepStep(async () => idle, track);
  assert.equal(step.phase, "after");
  await step.run();
  assert.deepEqual(events, []);
  await scorerSweepStep(async () => ({ ...idle, tracesScanned: 3 }), track).run();
  const skip = { projectId: PROJECT, scorerId: "s", traces: 2 };
  await scorerSweepStep(
    async () => ({ ...idle, tracesScanned: 2, budgetSkips: [skip] }),
    track,
  ).run();
  assert.deepEqual(events, [
    "feature.scorers.swept",
    "feature.scorers.swept",
    "feature.scorers.judge_skipped",
  ]);
});

async function scorer(
  client: { exec(sql: string): Promise<unknown> },
  db: ReturnType<typeof getDb>,
  overrides: Parameters<typeof checkDraft>[0] = {},
) {
  const id = await createScorer(PROJECT, checkDraft(overrides), "u1", db);
  await client.exec(
    `update trace_scorers set cursor_at = now() - interval '1 hour', created_at = now() - interval '1 hour' where id = '${id}'`,
  );
  return id;
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const add = async (
    traceId: string,
    trace: {
      ageS: number;
      receivedAgeS?: number;
      project?: string;
      models?: string[];
      attributes?: Record<string, unknown>;
    },
  ) => {
    const project = trace.project ?? PROJECT;
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, models, spans_max_received_at, updated_at)
       values ($1, $2, now(), 500, false, 1, 1, 0, $3, now() - $4 * interval '1 second', now() - $5 * interval '1 second')`,
      [project, traceId, trace.models ?? [], trace.receivedAgeS ?? trace.ageS, trace.ageS],
    );
    if (trace.attributes)
      await client.query(
        `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
         values (gen_random_uuid(), $1, $2, 'root', 'run', 1, 'agent', now(), now(), 500, 0, $3)`,
        [project, traceId, JSON.stringify(trace.attributes)],
      );
  };
  const turn = async (input: { key: string; project?: string; stepTraces?: string[] }) => {
    const project = input.project ?? PROJECT;
    const { rows } = await client.query<{ id: string }>(
      `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at)
       values ($1, $2, $2, 'otlp', 'otlp', 'closed', now(), now(), now()) returning id`,
      [project, input.key],
    );
    for (const [index, traceId] of (input.stepTraces ?? []).entries()) {
      const event = crypto.randomUUID();
      await client.query(
        `insert into trace_events (id, project_id, client_event_id, type, occurred_at, trace_id, payload)
         values ($1, $2, $3, 'invoke_end', now(), $3, '{}')`,
        [event, project, traceId],
      );
      await client.query(
        `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at)
         values ($1, $2, $3, 'invoke', 'invoke_end', $4, now(), now())`,
        [rows[0]?.id, project, index + 1, event],
      );
    }
  };
  /** A completed signal run that read everything up to now. */
  const reading = () =>
    client.exec(`insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, ledger_through)
      values ('${PROJECT}', 'scheduled', 'completed', 7, now() - interval '7 days', now(), now())`);
  const scored = async (scorerId: string) =>
    (await latestScores(PROJECT, scorerId, 1000, db)).map((row) => row.traceId).sort();
  return { client, db, add, scored, turn, reading };
}
