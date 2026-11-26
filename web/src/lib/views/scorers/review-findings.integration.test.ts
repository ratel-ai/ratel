import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { resolveConfig } from "@/config";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { enqueueScoreTasksJob } from "@/lib/views/task-scorers/job";
import { scorersFor } from "@/lib/views/task-scorers/store";
import { MAX_SCORERS, TASK_JUDGE_SAMPLE_RATE, TASK_SCORERS_ACTOR } from "./config";
import { limitText } from "./format";
import { loadScorerPicker } from "./picker";
import {
  countScorers,
  createScorer,
  getScorer,
  latestScores,
  listScorers,
  listTaskScorers,
  setScorerEnabled,
} from "./store";
import { sweepScorers } from "./sweep";
import { saveTaskScorer, seedTaskPresets, updateScorerWithTask } from "./task-presets";
import { loadTaskScorers } from "./task-scores";

/**
 * The major findings of the review of the one scorer model, each as the case that showed it, and
 * the paths they changed with `customMonitoring` off.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
type Db = ReturnType<typeof getDb>;

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, ledger_through)
      values ('${PROJECT}', 'scheduled', 'completed', 7, now() - interval '7 days', now() + interval '1 day', now() + interval '1 day');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

let turns = 0;
async function addTurn(
  client: PGlite,
  task: string,
  opts: { status?: string; trace?: string; durationMs?: number } = {},
) {
  turns += 1;
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(turns).padStart(12, "0")}`;
  const start = new Date(Date.now() - 3_600_000);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
    [
      id,
      PROJECT,
      `s-${turns}`,
      opts.trace ? `otlp:${opts.trace}` : `run-${turns}`,
      opts.trace ? "otlp" : "declared",
      opts.trace ? "otlp" : "runtime",
      opts.status ?? "closed",
      start.toISOString(),
      new Date(start.getTime() + (opts.durationMs ?? 1000)).toISOString(),
      task,
    ],
  );
  return id;
}

async function addSummary(client: PGlite, trace: string) {
  await client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
     values ($1, $2, now() - interval '10 minutes', 1000, false, 1, 1, 0.01, now(), now() - interval '60 seconds')`,
    [PROJECT, trace],
  );
}

/** A judge engine that counts its calls. */
function countingJudge() {
  const calls = { n: 0 };
  return {
    calls,
    deps: {
      flagOn: async () => true,
      judge: {
        engine: {
          model: "m",
          usdPerInputToken: 0.000001,
          ask: async () => {
            calls.n += 1;
            return { answer: { choice: "pass", confidence: 1 }, inputTokens: 10 };
          },
        },
        loadConversation: async () => ({ input: "hi", output: "ok" }) as never,
      },
    },
  };
}

test("major 1: the picker gives the count the server limit reads, without the system scorers", async () => {
  const { client, db } = await setup();
  try {
    await client.exec(`insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
      select '${PROJECT}', 'Fast ' || n, 'check', '{"path":"duration_ms","op":"lte","value":1000}', 'u1', 'u1'
      from generate_series(1, 60) n`);
    for (let t = 0; t < 20; t++) {
      await addTurn(client, `task-${t}`, { durationMs: 1000 });
      await addTurn(client, `task-${t}`, { durationMs: 3000 });
    }
    assert.ok((await seedTaskPresets(PROJECT, new Date(), db)) > 0);
    const picker = await loadScorerPicker(PROJECT, new Date(), db);
    assert.equal(picker.count, await countScorers(PROJECT, db));
    assert.equal(picker.count, 60);
    assert.ok(picker.scorers.length > MAX_SCORERS, "the system scorers are still listed");
    assert.equal(limitText(picker.count, picker.limit).full, false);
  } finally {
    await client.close();
  }
});

test("major 2: a task scorer save never changes a scorer that a person shares with another task", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    await addTurn(client, "task-b");
    const shared = await createScorer(
      PROJECT,
      {
        name: "Cost cap",
        kind: "preset",
        config: { preset: "max_tool_calls", max: 10 },
        filter: {},
        tasks: ["task-a", "task-b"],
        sampleRate: 100,
        enabled: true,
      },
      "u1",
      db,
    );
    for (const live of [true, false]) {
      await saveTaskScorer(
        {
          projectId: PROJECT,
          taskId: "task-a",
          scorer: { kind: "max_tool_calls", max: live ? 2 : 3 },
          enabled: false,
          updatedBy: "u1",
        },
        live,
        db,
      );
      const after = await getScorer(PROJECT, shared, db);
      assert.deepEqual(after?.config, { preset: "max_tool_calls", max: 10 }, `live ${live}`);
      assert.equal(after?.enabled, true);
      assert.deepEqual(after?.tasks, ["task-a", "task-b"]);
      const own = (await listTaskScorers(PROJECT, "task-a", db)).filter(
        (scorer) => scorer.id !== shared,
      );
      assert.equal(own.length, 1, "task-a has one scorer of its own, made once");
      assert.deepEqual(own[0]?.config, { preset: "max_tool_calls", max: live ? 2 : 3 });
      assert.equal(own[0]?.enabled, false);
      assert.deepEqual(own[0]?.tasks, ["task-a"]);
    }
  } finally {
    await client.close();
  }
});

test("major 3: flag off, a saved judge_criteria makes a judge that is off, and turning it on judges no backlog", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a", { trace: "t-1" });
    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Did it book?" },
        enabled: true,
        updatedBy: "u1",
      },
      false,
      db,
    );
    const [judge] = await listTaskScorers(PROJECT, "task-a", db);
    assert.equal(judge?.kind, "judge");
    assert.equal(judge?.enabled, false, "no live judge with the flag off");
    assert.equal(judge?.sampleRate, TASK_JUDGE_SAMPLE_RATE);
    // The eval gate still has the task scorer as the person saved it.
    const gate = (await scorersFor(PROJECT, "task-a", db)).find((s) => s.kind === "judge_criteria");
    assert.equal(gate?.enabled, true);

    await client.exec(
      `update trace_scorers set cursor_at = now() - interval '30 days', created_at = now() - interval '30 days'`,
    );
    for (let n = 1; n <= 8; n++) {
      if (n > 1) await addTurn(client, "task-a", { trace: `t-${n}` });
      await addSummary(client, `t-${n}`);
    }
    const { calls, deps } = countingJudge();
    await sweepScorers(deps, db);
    assert.equal(calls.n, 0, "the flag turns on: an off judge makes no call");
    assert.ok(judge);
    await setScorerEnabled(PROJECT, judge.id, true, "u1", db);
    await sweepScorers(deps, db);
    assert.equal(calls.n, 0, "turned on, it starts now: the backlog is not judged");
  } finally {
    await client.close();
  }
});

test("major 4: a converted judge shows its off state, and a save neither turns it on nor reads every trace", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    // What migration 0055 leaves: the system's judge of the criteria, off, at a sample of 100.
    const converted = await createScorer(
      PROJECT,
      {
        name: "Passing criteria · task-a",
        kind: "judge",
        config: { prompt: "Did it book?", output: "boolean" },
        filter: {},
        tasks: ["task-a"],
        sampleRate: 100,
        enabled: false,
      },
      TASK_SCORERS_ACTOR,
      db,
    );
    const [shown] = await loadTaskScorers(PROJECT, "task-a", new Date(), db);
    assert.equal(shown?.offAfterConversion, true);

    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Did it book?" },
        enabled: true,
        updatedBy: "u1",
      },
      true,
      db,
    );
    const after = await getScorer(PROJECT, converted, db);
    assert.equal(after?.enabled, false, "a save does not turn the judge on");
    assert.equal(after?.sampleRate, TASK_JUDGE_SAMPLE_RATE);

    // A judge a person made shows no conversion note.
    await createScorer(
      PROJECT,
      {
        name: "Mine",
        kind: "judge",
        config: { prompt: "Polite?", output: "boolean" },
        filter: {},
        tasks: ["task-a"],
        sampleRate: 100,
        enabled: false,
      },
      "u1",
      db,
    );
    const notes = (await loadTaskScorers(PROJECT, "task-a", new Date(), db)).map(
      (scorer) => scorer.offAfterConversion,
    );
    assert.deepEqual(notes, [true, false]);
  } finally {
    await client.close();
  }
});

test("major 5: a trace of a run that is still open is scored once the run closes", async () => {
  const { client, db } = await setup();
  try {
    const turn = await addTurn(client, "task-a", { trace: "t-open", status: "open" });
    await addSummary(client, "t-open");
    const id = await createScorer(
      PROJECT,
      {
        name: "Ends",
        kind: "preset",
        config: { preset: "max_latency_ms", max: 999_999 },
        filter: {},
        tasks: ["task-a"],
        sampleRate: 100,
        enabled: true,
      },
      "u1",
      db,
    );
    await client.exec(
      `update trace_scorers set cursor_at = now() - interval '1 hour', created_at = now() - interval '1 hour' where id = '${id}'`,
    );
    const first = await sweepScorers({ flagOn: async () => true }, db);
    assert.equal(first.scoresWritten, 0, "the run is open: the cursor waits");
    await client.exec(`update trace_turns set status = 'closed' where id = '${turn}'`);
    await sweepScorers({ flagOn: async () => true }, db);
    assert.equal((await latestScores(PROJECT, id, 10, db)).length, 1);
  } finally {
    await client.close();
  }
});

test("major 5: a run open past the hold is passed, and the scorer goes on", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a", { trace: "t-stale", status: "open" });
    await addTurn(client, "task-a", { trace: "t-done" });
    await addSummary(client, "t-stale");
    await addSummary(client, "t-done");
    await client.exec(
      `update otel_trace_summaries set updated_at = now() - interval '2 hours' where trace_id = 't-stale'`,
    );
    const id = await createScorer(
      PROJECT,
      {
        name: "Ends",
        kind: "preset",
        config: { preset: "max_latency_ms", max: 999_999 },
        filter: {},
        tasks: ["task-a"],
        sampleRate: 100,
        enabled: true,
      },
      "u1",
      db,
    );
    await client.exec(
      `update trace_scorers set cursor_at = now() - interval '3 hours', created_at = now() - interval '3 hours' where id = '${id}'`,
    );
    await sweepScorers({ flagOn: async () => true }, db);
    const scored = (await latestScores(PROJECT, id, 10, db)).map((score) => score.traceId);
    assert.deepEqual(scored, ["t-done"]);
  } finally {
    await client.close();
  }
});

test("major 6: a Panel edit of a task's system scorer reaches task_scorers, which the eval gate reads", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 2 },
        enabled: true,
        updatedBy: "u1",
      },
      true,
      db,
    );
    const [preset] = await listTaskScorers(PROJECT, "task-a", db);
    assert.ok(preset);
    const { id, projectId: _p, createdAt: _c, updatedAt: _u, ...draft } = preset;
    await updateScorerWithTask(
      PROJECT,
      id,
      { ...draft, config: { preset: "max_tool_calls", max: 50 }, enabled: false } as never,
      "u1",
      db,
    );
    const gate = (await scorersFor(PROJECT, "task-a", db)).find((s) => s.kind === "max_tool_calls");
    assert.deepEqual(gate && "max" in gate ? [gate.max, gate.enabled] : null, [50, false]);

    // A person's scorer edited in the Panel writes nothing back.
    const mine = await createScorer(
      PROJECT,
      {
        name: "Mine",
        kind: "preset",
        config: { preset: "max_cost_usd", max: 1 },
        filter: {},
        tasks: ["task-a"],
        sampleRate: 100,
        enabled: true,
      },
      "u1",
      db,
    );
    const person = await getScorer(PROJECT, mine, db);
    assert.ok(person);
    const { id: mineId, projectId: _q, createdAt: _d, updatedAt: _v, ...mineDraft } = person;
    await updateScorerWithTask(
      PROJECT,
      mineId,
      { ...mineDraft, config: { preset: "max_cost_usd", max: 9 } } as never,
      "u1",
      db,
    );
    const cost = (await scorersFor(PROJECT, "task-a", db)).find((s) => s.kind === "max_cost_usd");
    assert.notEqual(cost && "max" in cost ? cost.max : null, 9);
  } finally {
    await client.close();
  }
});

test("minor: with evalGate off and customMonitoring on, new tasks still get their presets", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    let seeded = 0;
    await enqueueScoreTasksJob(PROJECT, {
      db,
      flagDeps: resolveConfig({ override: { flags: { evalGate: false } } }),
      scorersOn: async () => true,
      seedPresets: async () => {
        seeded += 1;
      },
      observability: { trackSystemEvent: async () => {} },
    } as never);
    assert.equal(seeded, 1);
    // A seed that throws is logged: the job still finishes.
    await enqueueScoreTasksJob(PROJECT, {
      db,
      flagDeps: resolveConfig({ override: { flags: { evalGate: false } } }),
      scorersOn: async () => true,
      seedPresets: async () => {
        throw new Error("seed broke");
      },
      observability: { trackSystemEvent: async () => {} },
    } as never);
    // Flag off: no seed, as before.
    let seededOff = 0;
    await enqueueScoreTasksJob(PROJECT, {
      db,
      flagDeps: resolveConfig({ override: { flags: { evalGate: false } } }),
      scorersOn: async () => false,
      seedPresets: async () => {
        seededOff += 1;
      },
      observability: { trackSystemEvent: async () => {} },
    } as never);
    assert.equal(seededOff, 0);
  } finally {
    await client.close();
  }
});

test("minor: two seeds of the same task at the same time make each scorer once", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a", { durationMs: 1000 });
    await addTurn(client, "task-a", { durationMs: 3000 });
    await Promise.all([
      seedTaskPresets(PROJECT, new Date(), db),
      seedTaskPresets(PROJECT, new Date(), db),
    ]);
    const names = (await listScorers(PROJECT, db)).map((scorer) => scorer.name);
    assert.ok(names.length > 0);
    assert.equal(new Set(names).size, names.length, names.join(", "));
  } finally {
    await client.close();
  }
});

test("flag off: a preset save still moves the task's own scorer with it, as before", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 2000 },
        enabled: true,
        updatedBy: "u1",
      },
      false,
      db,
    );
    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 3000 },
        enabled: false,
        updatedBy: "u1",
      },
      false,
      db,
    );
    const scorers = await listTaskScorers(PROJECT, "task-a", db);
    assert.equal(scorers.length, 1);
    assert.deepEqual(scorers[0]?.config, { preset: "max_latency_ms", max: 3000 });
    assert.equal(scorers[0]?.enabled, false);
    const gate = (await scorersFor(PROJECT, "task-a", db)).find((s) => s.kind === "max_latency_ms");
    assert.deepEqual(gate && "max" in gate ? [gate.max, gate.enabled] : null, [3000, false]);
  } finally {
    await client.close();
  }
});

test("a Panel edit of an off converted judge changes the criteria, and the eval gate keeps grading with it", async () => {
  const { client, db } = await setup();
  try {
    await addTurn(client, "task-a");
    await saveTaskScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Did it book?" },
        enabled: true,
        updatedBy: "u1",
      },
      false,
      db,
    );
    const [judge] = await listTaskScorers(PROJECT, "task-a", db);
    assert.equal(judge?.enabled, false, "the live judge is off");
    assert.ok(judge && judge.kind === "judge");
    const { id, projectId: _p, createdAt: _c, updatedAt: _u, ...draft } = judge;
    await updateScorerWithTask(
      PROJECT,
      id,
      { ...draft, config: { ...judge.config, prompt: "Did it book the right day?" } } as never,
      "u1",
      db,
    );
    const gate = (await scorersFor(PROJECT, "task-a", db)).find((s) => s.kind === "judge_criteria");
    assert.deepEqual(gate && "criteria" in gate ? [gate.criteria, gate.enabled] : null, [
      "Did it book the right day?",
      true,
    ]);
  } finally {
    await client.close();
  }
});
