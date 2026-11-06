import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { resolveEvalModels } from "@/lib/views/eval-gate/models";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { whatIfStepJob } from "./job";
import { requestWhatIf, WhatIfError } from "./runs";
import { sessionReplayRuns } from "./schema";
import type { Variant } from "./variant";

/**
 * With no model key a What-if run calls nothing: the replay has no agent, so the run fails
 * `noModel` and frees its hold, and the network is never touched. `EVAL_GATE_MOCK_MODEL=1`
 * gives the eval gate's deterministic stand-ins locally, so a replay completes. With
 * `FF_SESSION_REPLAY` off no run can start. No upstream counterpart (the sibling of
 * `views/eval-gate/no-outbound-without-key.test.ts`).
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TURN = "33333333-3333-4333-8333-333333333331";
const MODEL = "claude-sonnet-4-6";
const ON = { FF_SESSION_REPLAY: "1" };
const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };

type Db = ReturnType<typeof getDb>;

const ADD: Variant = {
  kind: "add_tool",
  tool: {
    name: "quote_fare",
    description: "Quotes a fare.",
    parameters: { type: "object", properties: {} },
  },
};

let fetches = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("no outbound call is allowed here");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
      ('${TURN}', '${PROJECT}', 'session-1', 'k1', 'declared', 'runtime', 'closed', now(), now(), now());
    insert into session_replay_settings (project_id, read_content) values ('${PROJECT}', true);
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

/** One captured step: the ask, then a call to find_booking. */
function recorded(): { run: RunRecord; calls: ModelCall[] } {
  const payload: CloudEvent = {
    provider: "anthropic",
    model: MODEL,
    ts: new Date().toISOString(),
    system: "You are a travel agent.",
    tools: [
      {
        name: "find_booking",
        description: "Finds a booking.",
        parameters: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Hold the fare for R1" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "toolu_0", name: "find_booking", arguments: { ref: "R1" } },
        ],
      },
    ],
    finish_reason: "tool_call",
  };
  return {
    run: {
      turnId: TURN,
      traceId: "trace-1",
      startedAt: new Date().toISOString(),
      taskId: null,
      steps: [{ kind: "invoke", ordinal: 1, targetId: "find_booking", outcome: "ok" }],
    },
    calls: [
      {
        turnId: TURN,
        occurredAt: new Date(),
        model: MODEL,
        finishReason: "tool_call",
        costUsd: 0.003,
        latencyMs: 800,
        inputTokens: 900,
        outputTokens: 30,
        payload,
      },
    ],
  };
}

async function runOnce(db: Db, env: Record<string, string | undefined>) {
  const { run } = await requestWhatIf(
    { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD, replay: true },
    { db, flagDeps: ON, enqueue: async () => null },
  );
  const result = await whatIfStepJob(
    PROJECT,
    { runId: run.id, variant: ADD },
    {
      db,
      flagDeps: ON,
      models: resolveEvalModels(env, "eval_gate_judge", "development", "eval_gate_what_if"),
      loadStep: async () => recorded(),
      loadCorpus: async () => [],
    },
  );
  const [saved] = await db.select().from(sessionReplayRuns).where(eq(sessionReplayRuns.id, run.id));
  return { result, saved: saved! };
}

test("with no key a replay run calls nothing, fails noModel and frees its hold", async () => {
  const { client, db } = await setup();
  try {
    const { result, saved } = await runOnce(db, NO_KEYS);
    assert.equal(result.status, "failed");
    assert.equal(saved.errorCode, "noModel");
    assert.deepEqual(saved.spend, { usd: 0, reserved: false, capUsd: 0.5 });
    assert.equal(await organizationModelSpendSince(PROJECT, new Date(0), db), 0);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("EVAL_GATE_MOCK_MODEL=1 completes a replay on the stand-ins, with no outbound call", async () => {
  const { client, db } = await setup();
  try {
    const { result, saved } = await runOnce(db, { ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" });
    assert.equal(result.status, "completed");
    assert.equal(saved.method, "replay");
    assert.equal(saved.recordedTool, "find_booking");
    assert.ok(saved.distribution);
    assert.equal(saved.spend.reserved, false);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("with FF_SESSION_REPLAY off no run starts and nothing is saved", async () => {
  const { client, db } = await setup();
  try {
    await assert.rejects(
      requestWhatIf(
        { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD },
        { db, flagDeps: {}, enqueue: async () => assert.fail("nothing is queued") },
      ),
      (err: unknown) => err instanceof WhatIfError && err.code === "flag_off",
    );
    assert.equal((await db.select().from(sessionReplayRuns)).length, 0);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});
