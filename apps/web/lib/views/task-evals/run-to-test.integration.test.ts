import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import { taskEvalCases, taskTestDrafts } from "@/lib/views/task-evals/schema";
import { draftTestFromRun, type RunTestDraftDeps } from "./run-to-test";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const NOW = new Date("2026-11-02T12:00:00Z");
const PROPOSAL = {
  name: "Track the delivery",
  ask: "Where is the steel delivery?",
  expected: {
    tool: "track_delivery",
    maxToolCalls: 2,
    maxSelfCorrections: 0,
    maxLatencyMs: 5000,
    maxCostUsd: 0.02,
  },
  criteria: "Return the delivery status and arrival date.",
};

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent'),
      ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      values ('${TURN}', '${PROJECT}', 'run', 'run', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a');
  `);
  let calls = 0;
  const deps: RunTestDraftDeps = {
    db,
    now: () => NOW,
    // Owned (ADR-0030): the gate is the FF_EVAL_GATE env value, not an organization flag.
    flagDeps: { FF_EVAL_GATE: "1" },
    model: {
      model: "claude-haiku-5-5",
      standIn: false,
      draft: async (input) => {
        calls++;
        assert.match(input, /task-a/);
        return { text: JSON.stringify(PROPOSAL), usage: { inputTokens: 100, outputTokens: 100 } };
      },
    },
  };
  return { client, db, deps, calls: () => calls };
}

test("a valid model answer gives a proposal and charges the shared organization budget", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await draftTestFromRun(PROJECT, "task-a", TURN, f.deps), PROPOSAL);
    assert.equal(f.calls(), 1);
    assert.ok(
      (await organizationModelSpendSince(OTHER, new Date(NOW.getTime() - 86400000), f.db)) > 0,
    );
    assert.equal(
      (await f.db.select().from(taskEvalCases)).length,
      0,
      "Drafting does not save a case.",
    );
  } finally {
    await f.client.close();
  }
});

test("invalid output gives a clear error and still counts the model charge", async () => {
  const f = await setup();
  try {
    f.deps.model = {
      model: "claude-haiku-5-5",
      standIn: false,
      draft: async () => ({
        text: '{"name":"incomplete"}',
        usage: { inputTokens: 100, outputTokens: 100 },
      }),
    };
    await assert.rejects(
      draftTestFromRun(PROJECT, "task-a", TURN, f.deps),
      /invalid test proposal/,
    );
    assert.ok(
      (await organizationModelSpendSince(PROJECT, new Date(NOW.getTime() - 86400000), f.db)) > 0,
    );
  } finally {
    await f.client.close();
  }
});

test("a spent organization budget refuses before the model call", async () => {
  const f = await setup();
  try {
    await f.db.insert(taskTestDrafts).values({
      projectId: OTHER,
      taskId: "task-a",
      turnId: TURN,
      spend: { usd: 10, reserved: false },
      createdAt: NOW,
    });
    await assert.rejects(
      draftTestFromRun(PROJECT, "task-a", TURN, f.deps),
      /daily model budget is spent/,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.client.close();
  }
});

test("the flag and project and task boundaries refuse before a model call", async () => {
  const f = await setup();
  try {
    await assert.rejects(draftTestFromRun(OTHER, "task-a", TURN, f.deps), /No completed run/);
    await assert.rejects(draftTestFromRun(PROJECT, "task-b", TURN, f.deps), /No completed run/);
    f.deps.flagDeps!.FF_EVAL_GATE = "0";
    await assert.rejects(draftTestFromRun(PROJECT, "task-a", TURN, f.deps), /eval gate is off/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.client.close();
  }
});

test("a pending draft reserves the shared budget before another draft can call the model", async () => {
  const f = await setup();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: Promise<unknown> | undefined;
  let calls = 0;
  try {
    f.deps.model = {
      model: "claude-haiku-5-5",
      standIn: false,
      draft: async () => {
        calls++;
        started();
        await barrier;
        return { text: JSON.stringify(PROPOSAL), usage: { inputTokens: 100, outputTokens: 100 } };
      },
    };
    first = draftTestFromRun(PROJECT, "task-a", TURN, f.deps);
    await ready;
    const reserved = await organizationModelSpendSince(
      PROJECT,
      new Date(NOW.getTime() - 86400000),
      f.db,
    );
    assert.ok(reserved > 0);
    await assert.rejects(
      draftTestFromRun(PROJECT, "task-a", TURN, { ...f.deps, dailyBudgetUsd: reserved }),
      /daily model budget is spent/,
    );
    assert.equal(calls, 1);
    release();
    await first;
    const settled = await organizationModelSpendSince(
      PROJECT,
      new Date(NOW.getTime() - 86400000),
      f.db,
    );
    assert.ok(settled > 0 && settled < reserved);
  } finally {
    release();
    await first;
    await f.client.close();
  }
});
