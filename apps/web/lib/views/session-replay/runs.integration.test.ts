import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import type { AgentModel, EvalModels } from "@/lib/views/eval-gate/models";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import type { OrganizationFlagDeps } from "@/lib/views/session-replay/gate";
import { type WhatIfJobDeps, whatIfStepJob } from "@/lib/views/session-replay/job";
import {
  pruneWhatIfRuns,
  type RequestWhatIfDeps,
  requestWhatIf,
  WHAT_IF_JOB,
  WHAT_IF_RUN_CAP_USD,
  WhatIfError,
} from "@/lib/views/session-replay/runs";
import { sessionReplayRuns, sessionReplaySettings } from "@/lib/views/session-replay/schema";
import type { Variant } from "@/lib/views/session-replay/variant";

/**
 * RC-176: a What-if run is queued under the organization's daily budget,
 * runs as a `what_if_step` job, saves numbers only, and expires.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const TURN = "33333333-3333-4333-8333-333333333331";
const OTHER_TURN = "33333333-3333-4333-8333-333333333332";
const MODEL = "claude-sonnet-4-6";

type Db = ReturnType<typeof getDb>;

async function setup(options: { readContent?: boolean } = {}): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values
      ('${TURN}', '${PROJECT}', 'session-1', 'k1', 'declared', 'runtime', 'closed', now(), now(), now()),
      ('${OTHER_TURN}', '${OTHER_PROJECT}', 'session-2', 'k2', 'declared', 'runtime', 'closed', now(), now(), now());
  `);
  if (options.readContent !== undefined)
    await client.exec(
      `insert into session_replay_settings (project_id, read_content) values ('${PROJECT}', ${options.readContent})`,
    );
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

// Owned (ADR-0030): the flag is FF_SESSION_REPLAY in the environment the gate reads.
function flags(on: boolean): OrganizationFlagDeps {
  return on ? { FF_SESSION_REPLAY: "1" } : {};
}

const ADD: Variant = {
  kind: "add_tool",
  tool: {
    name: "quote_fare",
    description: "Quotes a fare.",
    parameters: { type: "object", properties: {} },
  },
};

function requestDeps(
  db: Db,
  over: Partial<RequestWhatIfDeps> = {},
): RequestWhatIfDeps & { queued: unknown[] } {
  const queued: unknown[] = [];
  return {
    db,
    flagDeps: flags(true),
    enqueue: async (_projectId, payload) => {
      queued.push(payload);
      return null;
    },
    queued,
    ...over,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WhatIfError, String(err));
    return err.code;
  }
  assert.fail("expected a refusal");
}

/* - requestWhatIf ------------------------------------------------------------- */

test("requestWhatIf reserves the run's cap and queues what_if_step; the same live request is reused", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const deps = requestDeps(db);
    const { run, created } = await requestWhatIf(
      {
        projectId: PROJECT,
        actor: "user_1",
        turnId: TURN,
        step: 1,
        variant: ADD,
        variantRef: "quote_fare",
        replay: true,
      },
      deps,
    );
    assert.equal(created, true);
    assert.equal(run.sessionId, "session-1");
    assert.equal(run.method, "replay");
    assert.equal(run.k, 5);
    assert.deepEqual(run.spend, {
      usd: WHAT_IF_RUN_CAP_USD,
      reserved: true,
      capUsd: WHAT_IF_RUN_CAP_USD,
    });
    assert.deepEqual(deps.queued, [{ runId: run.id, variant: ADD }]);
    // The hold counts toward the organization's daily budget while the run is live.
    assert.equal(
      await organizationModelSpendSince(PROJECT, new Date(Date.now() - 86_400_000), db),
      WHAT_IF_RUN_CAP_USD,
    );
    const again = await requestWhatIf(
      { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 1, variant: ADD, replay: true },
      deps,
    );
    assert.equal(again.created, false);
    assert.equal(again.run.id, run.id);
    assert.equal(deps.queued.length, 1);
    assert.equal(WHAT_IF_JOB, "what_if_step");
  } finally {
    await client.close();
  }
});

test("requestWhatIf refuses when the flag is off for the actor", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    assert.equal(
      await refusal(
        requestWhatIf(
          { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD },
          requestDeps(db, { flagDeps: flags(false) }),
        ),
      ),
      "flag_off",
    );
  } finally {
    await client.close();
  }
});

test("requestWhatIf refuses a run of another project", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    assert.equal(
      await refusal(
        requestWhatIf(
          { projectId: PROJECT, actor: "user_1", turnId: OTHER_TURN, step: 0, variant: ADD },
          requestDeps(db),
        ),
      ),
      "not_found",
    );
    assert.equal(
      await refusal(
        requestWhatIf(
          { projectId: PROJECT, actor: "user_1", turnId: "not-a-uuid", step: 0, variant: ADD },
          requestDeps(db),
        ),
      ),
      "not_found",
    );
  } finally {
    await client.close();
  }
});

test("requestWhatIf refuses a model replay while the content opt-in is off, and re-ranks by default", async () => {
  const { client, db } = await setup();
  try {
    assert.equal(
      await refusal(
        requestWhatIf(
          {
            projectId: PROJECT,
            actor: "user_1",
            turnId: TURN,
            step: 0,
            variant: ADD,
            replay: true,
          },
          requestDeps(db),
        ),
      ),
      "content_opt_in_off",
    );
    const { run } = await requestWhatIf(
      { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD },
      requestDeps(db),
    );
    assert.equal(run.method, "rerank");
    assert.equal(run.spend.usd, 0);
  } finally {
    await client.close();
  }
});

test("requestWhatIf refuses when the daily budget is spent", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    await db.insert(sessionReplayRuns).values({
      projectId: OTHER_PROJECT,
      sessionId: "session-2",
      turnId: OTHER_TURN,
      step: 0,
      variantKind: "add_tool",
      variantKey: "k",
      method: "replay",
      k: 5,
      spend: { usd: 9.8, reserved: false, capUsd: 0.5 },
      status: "completed",
      requestedBy: "user_1",
      finishedAt: new Date(),
    });
    const deps = requestDeps(db);
    assert.equal(
      await refusal(
        requestWhatIf(
          {
            projectId: PROJECT,
            actor: "user_1",
            turnId: TURN,
            step: 0,
            variant: ADD,
            replay: true,
          },
          deps,
        ),
      ),
      "budget_spent",
    );
    assert.equal(deps.queued.length, 0);
  } finally {
    await client.close();
  }
});

test("requestWhatIf refuses a negative or fractional step", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    assert.equal(
      await refusal(
        requestWhatIf(
          { projectId: PROJECT, actor: "user_1", turnId: TURN, step: -1, variant: ADD },
          requestDeps(db),
        ),
      ),
      "bad_step",
    );
  } finally {
    await client.close();
  }
});

/* - the job ----------------------------------------------------------------------- */

/** One recorded step: the ask, then a call to find_booking. */
function recorded(captured: boolean): { run: RunRecord; calls: ModelCall[] } {
  const messages: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Hold the fare for R1" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "toolu_0", name: "find_booking", arguments: { ref: "R1" } },
      ],
    },
  ];
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
    messages,
    finish_reason: "tool_call",
  };
  return {
    run: {
      turnId: TURN,
      traceId: "trace-1",
      startedAt: new Date().toISOString(),
      taskId: null,
      steps: [
        { kind: "search", ordinal: 0, query: "hold a fare", hitIds: null, topK: 5 },
        { kind: "invoke", ordinal: 1, targetId: "find_booking", outcome: "ok" },
      ],
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
        payload: captured ? payload : null,
      },
    ],
  };
}

function fakeModels(picks: (string | null)[]): EvalModels {
  let i = 0;
  const agent: AgentModel = {
    model: MODEL,
    standIn: false,
    async next() {
      const pick = picks[i++ % picks.length] ?? null;
      return {
        text: "",
        calls: pick ? [{ id: `c${i}`, name: pick, args: {} }] : [],
        usage: { inputTokens: 1_000, outputTokens: 20 },
        latencyMs: 1,
        model: MODEL,
      };
    },
  };
  return { agent: () => agent, tool: null, judge: null, standIn: false };
}

function jobDeps(db: Db, over: Partial<WhatIfJobDeps> = {}): WhatIfJobDeps {
  return {
    db,
    flagDeps: flags(true),
    models: fakeModels(["find_booking", "find_booking", "quote_fare"]),
    loadStep: async (_projectId, _turnId, withPayload) => recorded(withPayload),
    loadCorpus: async () => [],
    ...over,
  };
}

test("the job samples the step, saves numbers only and settles the spend", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const { run } = await requestWhatIf(
      {
        projectId: PROJECT,
        actor: "user_1",
        turnId: TURN,
        step: 0,
        variant: ADD,
        k: 3,
        replay: true,
      },
      requestDeps(db),
    );
    const result = await whatIfStepJob(PROJECT, { runId: run.id, variant: ADD }, jobDeps(db));
    assert.deepEqual(result, { runId: run.id, status: "completed" });
    const [saved] = await db
      .select()
      .from(sessionReplayRuns)
      .where(eq(sessionReplayRuns.id, run.id));
    assert.equal(saved!.status, "completed");
    assert.equal(saved!.method, "replay");
    assert.equal(saved!.recordedTool, "find_booking");
    assert.deepEqual(saved!.distribution, {
      before: { find_booking: 2, quote_fare: 1 },
      after: { find_booking: 2, quote_fare: 1 },
    });
    assert.deepEqual(saved!.tokens, {
      before: { input: 3_000, output: 60 },
      after: { input: 3_000, output: 60 },
    });
    assert.equal(saved!.spend.reserved, false);
    assert.ok(saved!.spend.usd > 0 && saved!.spend.usd <= WHAT_IF_RUN_CAP_USD);
    assert.ok(saved!.finishedAt);
    // A second delivery of the same job finds nothing to claim.
    assert.deepEqual(await whatIfStepJob(PROJECT, { runId: run.id, variant: ADD }, jobDeps(db)), {
      runId: run.id,
      status: "skipped",
    });
  } finally {
    await client.close();
  }
});

test("the job fails the run when the flag was turned off after it was queued, and frees its hold", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const { run } = await requestWhatIf(
      { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD, replay: true },
      requestDeps(db),
    );
    await whatIfStepJob(
      PROJECT,
      { runId: run.id, variant: ADD },
      jobDeps(db, { flagDeps: flags(false) }),
    );
    const [saved] = await db
      .select()
      .from(sessionReplayRuns)
      .where(eq(sessionReplayRuns.id, run.id));
    assert.equal(saved!.status, "failed");
    assert.equal(saved!.errorCode, "flag_off");
    assert.deepEqual(saved!.spend, { usd: 0, reserved: false, capUsd: WHAT_IF_RUN_CAP_USD });
  } finally {
    await client.close();
  }
});

test("the job re-ranks when the opt-in was turned off after a replay was queued", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const { run } = await requestWhatIf(
      { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD, replay: true },
      requestDeps(db),
    );
    await db
      .update(sessionReplaySettings)
      .set({ readContent: false })
      .where(eq(sessionReplaySettings.projectId, PROJECT));
    const seen: boolean[] = [];
    await whatIfStepJob(
      PROJECT,
      { runId: run.id, variant: ADD },
      jobDeps(db, {
        loadStep: async (_p, _t, withPayload) => {
          seen.push(withPayload);
          return recorded(withPayload);
        },
        rank: () => ({ before: () => ["find_booking"], after: () => ["quote_fare"] }),
      }),
    );
    assert.deepEqual(seen, [false]);
    const [saved] = await db
      .select()
      .from(sessionReplayRuns)
      .where(eq(sessionReplayRuns.id, run.id));
    assert.equal(saved!.status, "completed");
    assert.equal(saved!.method, "rerank");
    assert.equal(saved!.afterTool, "quote_fare");
    assert.equal(saved!.spend.usd, 0);
  } finally {
    await client.close();
  }
});

test("the job fails a run whose payload has no valid variant", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const { run } = await requestWhatIf(
      { projectId: PROJECT, actor: "user_1", turnId: TURN, step: 0, variant: ADD, replay: true },
      requestDeps(db),
    );
    await whatIfStepJob(PROJECT, { runId: run.id, variant: { kind: "nope" } }, jobDeps(db));
    const [saved] = await db
      .select()
      .from(sessionReplayRuns)
      .where(eq(sessionReplayRuns.id, run.id));
    assert.equal(saved!.status, "failed");
    assert.equal(saved!.errorCode, "bad_variant");
  } finally {
    await client.close();
  }
});

/* - retention ------------------------------------------------------------------- */

test("pruneWhatIfRuns deletes runs older than 30 days and times out stale live ones", async () => {
  const { client, db } = await setup({ readContent: true });
  try {
    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const base = {
      projectId: PROJECT,
      sessionId: "session-1",
      turnId: TURN,
      variantKind: "add_tool",
      method: "replay",
      k: 5,
      requestedBy: "user_1",
    } as const;
    await db.insert(sessionReplayRuns).values([
      {
        ...base,
        step: 0,
        variantKey: "old",
        spend: { usd: 0.1, reserved: false, capUsd: 0.5 },
        status: "completed",
        createdAt: days(31),
      },
      {
        ...base,
        step: 1,
        variantKey: "fresh",
        spend: { usd: 0.1, reserved: false, capUsd: 0.5 },
        status: "completed",
        createdAt: days(29),
      },
      {
        ...base,
        step: 2,
        variantKey: "stuck",
        spend: { usd: 0.5, reserved: true, capUsd: 0.5 },
        status: "running",
        createdAt: new Date(now.getTime() - 60 * 60_000),
        startedAt: new Date(now.getTime() - 60 * 60_000),
      },
      {
        ...base,
        step: 3,
        variantKey: "live",
        spend: { usd: 0.5, reserved: true, capUsd: 0.5 },
        status: "running",
        createdAt: now,
        startedAt: now,
      },
    ]);
    assert.deepEqual(await pruneWhatIfRuns(db, now), { pruned: 1, timedOut: 1 });
    const rows = await db.select().from(sessionReplayRuns);
    assert.deepEqual(rows.map((row) => row.variantKey).sort(), ["fresh", "live", "stuck"]);
    const stuck = rows.find((row) => row.variantKey === "stuck")!;
    assert.equal(stuck.status, "failed");
    assert.equal(stuck.errorCode, "timed_out");
    assert.equal(stuck.spend.reserved, false);
  } finally {
    await client.close();
  }
});
