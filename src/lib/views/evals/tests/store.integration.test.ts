import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";
import { evalResults, evals, evalTasks } from "@/lib/views/evals/schema";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;

test("creates an eval with its tasks and reads it back", async () => {
  const { client, store } = await setup();
  try {
    const created = await store.createEval({
      projectId: PROJECT,
      name: "Refund a late order",
      message: "refund order 42",
      origin: "user",
      createdBy: "user_a",
      earlierMessages: [{ role: "user", text: "hi" }],
      checks: { max_tool_calls: { on: true, max: 3 }, ends_well: { on: false } },
      expectedTool: "refund",
      fixedAnswers: [{ tool: "lookup", result: { id: 42 } }],
      tasks: ["wf-b", "wf-a"],
    });
    assert.equal(created.status, "suggested");
    assert.deepEqual(created.tasks, ["wf-a", "wf-b"]);
    const read = await store.getEval(PROJECT, created.id);
    assert.deepEqual(read, created);
    assert.equal(await store.getEval(OTHER, created.id), null, "Another project cannot read it.");
  } finally {
    await client.close();
  }
});

test("links tasks many-to-many and lists evals by task and status", async () => {
  const { client, store } = await setup();
  try {
    const a = await store.createEval({
      projectId: PROJECT,
      name: "A",
      message: "a",
      origin: "auto",
      createdBy: "t",
      status: "approved",
    });
    const b = await store.createEval({
      projectId: PROJECT,
      name: "B",
      message: "b",
      origin: "auto",
      createdBy: "t",
    });
    assert.equal(await store.linkTasks(PROJECT, a.id, ["wf-1", "wf-2"]), true);
    assert.equal(await store.linkTasks(PROJECT, a.id, ["wf-1"]), true, "Linking twice is a no-op.");
    assert.equal(await store.linkTasks(PROJECT, b.id, ["wf-1"]), true);
    assert.equal(await store.linkTasks(OTHER, b.id, ["wf-9"]), false);
    assert.deepEqual(
      (await store.listEvals(PROJECT, { workflowId: "wf-1" })).map((e) => e.name).sort(),
      ["A", "B"],
    );
    assert.deepEqual(
      (await store.listEvals(PROJECT, { workflowId: "wf-2" })).map((e) => e.name),
      ["A"],
    );
    assert.deepEqual(
      (await store.listEvals(PROJECT, { workflowId: "wf-1", statuses: ["approved"] })).map(
        (e) => e.name,
      ),
      ["A"],
    );
    assert.deepEqual((await store.getEval(PROJECT, a.id))!.tasks, ["wf-1", "wf-2"]);
    await store.unlinkTask(PROJECT, a.id, "wf-1");
    assert.deepEqual((await store.getEval(PROJECT, a.id))!.tasks, ["wf-2"]);
    assert.equal(await store.setEvalStatus(PROJECT, b.id, "archived"), true);
    assert.deepEqual(
      (await store.listEvals(PROJECT, { statuses: ["suggested", "approved"] })).map((e) => e.name),
      ["A"],
    );
    assert.deepEqual(await store.listEvals(OTHER), []);
  } finally {
    await client.close();
  }
});

test("records a run and its results, upserting a retried result", async () => {
  const { client, store } = await setup();
  try {
    const e = await store.createEval({
      projectId: PROJECT,
      name: "A",
      message: "a",
      origin: "user",
      createdBy: "t",
      status: "approved",
    });
    const run = await store.createRun({
      projectId: PROJECT,
      kind: "manual",
      createdBy: "user_a",
      suite: "All evals",
      evalCount: 1,
    });
    assert.equal(run.status, "queued");
    assert.equal(run.fixId, null);
    assert.deepEqual(run.spend, { usd: 0, reservedUsd: 0, reserved: false });
    const verdicts = [
      {
        kind: "max_tool_calls" as const,
        status: "fail" as const,
        measured: 5,
        limit: 3,
        detail: "5 tool calls",
      },
    ];
    const result = {
      evalId: e.id,
      passed: false,
      verdicts,
      change: "now_fails" as const,
      durationMs: 1200,
      costUsd: 0.01,
      toolCalls: 5,
      toolAnswers: [
        {
          tool: "lookup",
          source: "recorded" as const,
          reason: "matched_recording" as const,
          ms: 12,
        },
      ],
      transcript: {
        toolsOffered: ["lookup"],
        steps: [{ role: "assistant" as const, text: "done", calls: [] }],
      },
    };
    await store.recordResults(PROJECT, run.id, [result]);
    await store.recordResults(PROJECT, run.id, [{ ...result, costUsd: 0.02 }]);
    const results = await store.listResults(PROJECT, run.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.costUsd, 0.02);
    assert.equal(results[0]!.side, "before");
    assert.deepEqual(results[0]!.verdicts, verdicts);
    assert.deepEqual(results[0]!.toolAnswers, result.toolAnswers);
    assert.deepEqual(results[0]!.transcript, result.transcript);
    assert.deepEqual(await store.listResults(OTHER, run.id), []);
    await assert.rejects(
      store.recordResults(OTHER, run.id, [result]),
      "Another project cannot write to the run.",
    );

    await store.updateRun(PROJECT, run.id, {
      status: "completed",
      finishedAt: new Date(),
      spend: { usd: 0.02, reservedUsd: 0.5, reserved: false },
    });
    const done = await store.getRun(PROJECT, run.id);
    assert.equal(done!.status, "completed");
    assert.equal(done!.spend.usd, 0.02);
    assert.deepEqual(
      (await store.listRuns(PROJECT)).map((r) => r.id),
      [run.id],
    );
    assert.deepEqual(await store.listRuns(PROJECT, { kinds: ["nightly"] }), []);
  } finally {
    await client.close();
  }
});

test("a simulation run needs a fix and a manual run refuses one", async () => {
  const { client, store } = await setup();
  try {
    const sim = await store.createRun({
      projectId: PROJECT,
      kind: "simulation",
      fixId: "craft:1",
      createdBy: "t",
    });
    assert.equal(sim.fixId, "craft:1");
    await assert.rejects(
      store.createRun({ projectId: PROJECT, kind: "simulation", createdBy: "t" }),
    );
    await assert.rejects(
      store.createRun({ projectId: PROJECT, kind: "manual", fixId: "craft:1", createdBy: "t" }),
    );
  } finally {
    await client.close();
  }
});

test("recent results come from completed runs only, newest first, capped per eval", async () => {
  const { client, store } = await setup();
  try {
    const e = await store.createEval({
      projectId: PROJECT,
      name: "A",
      message: "a",
      origin: "user",
      createdBy: "t",
    });
    const base = Date.now() - 10 * DAY;
    for (let i = 0; i < 8; i += 1) {
      const run = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
      await store.recordResults(PROJECT, run.id, [
        { evalId: e.id, passed: i % 2 === 0, verdicts: [], createdAt: new Date(base + i * DAY) },
      ]);
      if (i < 7) await store.updateRun(PROJECT, run.id, { status: "completed" });
    }
    const recent = (await store.recentResults(PROJECT, [e.id], 6)).get(e.id)!;
    assert.equal(recent.length, 6);
    assert.deepEqual(
      recent.map((r) => r.createdAt.getTime()),
      [6, 5, 4, 3, 2, 1].map((i) => base + i * DAY),
    );
  } finally {
    await client.close();
  }
});

test("prune clears transcripts older than 30 days and keeps the numbers", async () => {
  const { client, store } = await setup();
  try {
    const e = await store.createEval({
      projectId: PROJECT,
      name: "A",
      message: "a",
      origin: "user",
      createdBy: "t",
    });
    const run = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    const e2 = await store.createEval({
      projectId: PROJECT,
      name: "B",
      message: "b",
      origin: "user",
      createdBy: "t",
    });
    const now = new Date();
    const transcript = {
      toolsOffered: [],
      steps: [{ role: "assistant" as const, text: "secret", calls: [] }],
    };
    const answers = [
      { tool: "lookup", source: "stand-in" as const, reason: "stand_in_model" as const, ms: null },
    ];
    await store.recordResults(PROJECT, run.id, [
      {
        evalId: e.id,
        passed: true,
        verdicts: [],
        costUsd: 0.03,
        durationMs: 900,
        toolAnswers: answers,
        transcript,
        createdAt: new Date(now.getTime() - 31 * DAY),
      },
      {
        evalId: e2.id,
        passed: true,
        verdicts: [],
        transcript,
        createdAt: new Date(now.getTime() - 29 * DAY),
      },
    ]);
    assert.equal(await store.pruneTranscripts(now), 1);
    assert.equal(await store.pruneTranscripts(now), 0, "A second prune finds nothing.");
    const byEval = new Map((await store.listResults(PROJECT, run.id)).map((r) => [r.evalId, r]));
    const old = byEval.get(e.id)!;
    assert.equal(old.transcript, null);
    assert.equal(old.costUsd, 0.03);
    assert.equal(old.durationMs, 900);
    assert.equal(old.passed, true);
    assert.deepEqual(old.toolAnswers, answers);
    assert.deepEqual(byEval.get(e2.id)!.transcript, transcript);
  } finally {
    await client.close();
  }
});

test("RC-318: prune clears each turn's message after 30 days, keeps the turn verdicts and numbers, and also prunes a result with turns but no transcript", async () => {
  const { client, store } = await setup();
  try {
    const run = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    const [old, oldNoTranscript, fresh] = [
      await store.createEval({
        projectId: PROJECT,
        name: "A",
        message: "a",
        origin: "user",
        createdBy: "t",
      }),
      await store.createEval({
        projectId: PROJECT,
        name: "B",
        message: "b",
        origin: "user",
        createdBy: "t",
      }),
      await store.createEval({
        projectId: PROJECT,
        name: "C",
        message: "c",
        origin: "user",
        createdBy: "t",
      }),
    ];
    const now = new Date();
    const verdict = {
      kind: "ends_well" as const,
      status: "pass" as const,
      measured: null,
      limit: null,
      detail: "ends well",
    };
    const turns = [
      {
        simulated: false,
        message: "Move me to an aisle seat",
        passed: true,
        verdicts: [verdict],
        answers: 2,
      },
      {
        simulated: true,
        message: "And my refund, card ending 4242?",
        passed: false,
        verdicts: [{ ...verdict, status: "fail" as const }],
        answers: 1,
      },
    ];
    const transcript = {
      toolsOffered: [],
      steps: [{ role: "assistant" as const, text: "secret", calls: [] }],
    };
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    await store.recordResults(PROJECT, run.id, [
      { evalId: old.id, passed: false, verdicts: [verdict], transcript, turns, createdAt: ago(31) },
      { evalId: oldNoTranscript.id, passed: false, verdicts: [verdict], turns, createdAt: ago(31) },
      {
        evalId: fresh.id,
        passed: false,
        verdicts: [verdict],
        transcript,
        turns,
        createdAt: ago(29),
      },
    ]);
    assert.equal(await store.pruneTranscripts(now), 2);
    assert.equal(await store.pruneTranscripts(now), 0, "A second prune finds nothing.");
    const byEval = new Map((await store.listResults(PROJECT, run.id)).map((r) => [r.evalId, r]));
    const kept = turns.map((turn) => ({ ...turn, message: null }));
    for (const id of [old.id, oldNoTranscript.id]) {
      assert.equal(byEval.get(id)!.transcript, null);
      assert.deepEqual(
        byEval.get(id)!.turns,
        kept,
        "Verdicts, pass/fail and answer counts stay; the text goes.",
      );
    }
    assert.deepEqual(byEval.get(fresh.id)!.turns, turns);
    assert.deepEqual(byEval.get(fresh.id)!.transcript, transcript);
  } finally {
    await client.close();
  }
});

test("deleting an eval removes its links and results", async () => {
  const { client, db, store } = await setup();
  try {
    const e = await store.createEval({
      projectId: PROJECT,
      name: "A",
      message: "a",
      origin: "user",
      createdBy: "t",
      tasks: ["wf-1"],
    });
    const run = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    await store.recordResults(PROJECT, run.id, [{ evalId: e.id, passed: true, verdicts: [] }]);
    await db.delete(evals);
    assert.equal((await db.select().from(evalTasks)).length, 0);
    assert.equal((await db.select().from(evalResults)).length, 0);
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  return { client, db, store: createDrizzleEvalStore(db) };
}
