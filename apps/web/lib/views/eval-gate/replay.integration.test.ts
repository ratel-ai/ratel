import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { setModelCallSink } from "@/lib/platform/model-call";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";
import { CANT_SIMULATE } from "./method";
import { type EvalModels, resolveEvalModels, standInModels } from "./models";
import { loadEvalGatePage } from "./page-model";
import { type EvalGateDeps, listEvalBadges, runSimulation } from "./service";
import { getEvalRun, getEvalSet, listCases, parseResults } from "./store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "44444444-4444-4444-8444-444444444441";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const SIBLING = "11111111-1111-4111-8111-111111111112";
const STRANGER = "11111111-1111-4111-8111-111111111113";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const at = (minutes: number, seconds = 0) =>
  new Date(NOW.getTime() - minutes * 60_000 + seconds * 1000);
const turnId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const eventId = (n: number, k: number) =>
  `bbbbbbbb-bbbb-4bbb-8bbb-${String(n * 100 + k).padStart(12, "0")}`;

type Db = ReturnType<typeof getDb>;

const FAILED = { error: "fare_no_longer_available" };

/**
 * Six runs of a travel agent that hold a fare. Runs 1 and 2 are the issue's
 * evidence. Runs 3 and 4 fail three times in a row and give up; run 5 holds
 * the fare at once; run 6 failed too, but its model calls weren't captured.
 * Each captured run stores its model calls as OTLP reconstructions do
 * (`events.payload`: system, tools, the conversation so far and the output).
 */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  const runs: { n: number; results: unknown[]; captured: boolean }[] = [
    { n: 1, results: [FAILED, FAILED, { held: true }], captured: true },
    { n: 2, results: [FAILED, FAILED, FAILED], captured: true },
    { n: 3, results: [FAILED, FAILED, FAILED], captured: true },
    { n: 4, results: [FAILED, FAILED, FAILED], captured: true },
    { n: 5, results: [{ held: true }], captured: true },
    { n: 6, results: [FAILED, FAILED], captured: false },
  ];
  for (const run of runs) {
    const start = at(100 - run.n);
    const end = at(100 - run.n, run.results.length * 2);
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, invoke_count, error_count)
       values ($1, $2, $3, $4, 'declared', 'runtime', 'closed', $5, $6, $6, $7, $8)`,
      [
        turnId(run.n),
        PROJECT,
        `s-${run.n}`,
        `declared:${run.n}`,
        start,
        end,
        run.results.length,
        run.results.filter((r) => r === FAILED).length,
      ],
    );
    const conversation: CloudMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hold the fare on booking R1" }] },
    ];
    for (const [index, value] of run.results.entries()) {
      const when = at(100 - run.n, index * 2);
      await client.query(
        `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, tool_id, payload)
         values ($1, $2, 'invoke_end', $3, $4, $4, $5, $6, 'hold_fare', '{}'::jsonb)`,
        [
          eventId(run.n, index),
          PROJECT,
          `s-${run.n}`,
          when,
          `c-${run.n}-${index}`,
          `trace-${run.n}`,
        ],
      );
      await client.query(
        `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
         values ($1, $2, $3, 'invoke', 'invoke_end', $4, $5, $5, 'tool', 'hold_fare', $6)`,
        [
          turnId(run.n),
          PROJECT,
          index + 1,
          eventId(run.n, index),
          when,
          value === FAILED ? "error" : "ok",
        ],
      );
      const id = `toolu_${run.n}_${index}`;
      const output: CloudMessage = {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "hold_fare", arguments: { ref: "R1" } }],
      };
      await insertCall(
        client,
        run.n,
        when,
        run.captured ? [...conversation, output] : [{ role: "user", content: "" }],
        "tool_call",
      );
      conversation.push(output, { role: "tool", tool_call_id: id, content: JSON.stringify(value) });
    }
    await insertCall(
      client,
      run.n,
      end,
      run.captured
        ? [
            ...conversation,
            { role: "assistant", content: [{ type: "text", text: "Sorry, that fare is gone." }] },
          ]
        : [{ role: "user", content: "" }],
      "stop",
    );
  }
  await client.query(
    `insert into trace_signals (id, project_id, kind, subject_kind, subject_key, subject, status, severity, impact, n, metrics, evidence, first_seen_at, last_seen_at)
     values ($1, $2, 'identical_retry', 'tool', 'hold_fare', '{"ids":["hold_fare"]}', 'open', 0.4, 30, 300, '{}', $3::jsonb, $4, $4)`,
    [ISSUE, PROJECT, JSON.stringify({ turnIds: [turnId(2), turnId(1)], totalTurns: 2 }), at(10)],
  );
  return { client, db };
}

async function insertCall(
  client: PGlite,
  n: number,
  when: Date,
  messages: CloudMessage[],
  finish: string,
): Promise<void> {
  const payload = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: when.toISOString(),
    system: "You are Meridian's travel assistant.",
    tools: [
      {
        name: "hold_fare",
        description: "Hold a fare for 24 hours.",
        parameters: { type: "object", properties: { ref: { type: "string" } } },
      },
      {
        name: "escalate_to_agent",
        description: "Hand over to a person.",
        parameters: { type: "object", properties: {} },
      },
    ],
    messages,
    finish_reason: finish,
  };
  await client.query(
    `insert into events (project_id, occurred_at, provider, model, finish_reason, latency_ms, input_tokens, output_tokens, cost_usd, payload, trace_id)
     values ($1, $2, 'anthropic', 'claude-sonnet-4-6', $3, 900, 800, 30, '0.002850', $4::jsonb, $5)`,
    [PROJECT, when, finish, JSON.stringify(payload), `trace-${n}`],
  );
}

/** A finished simulation of some other fix in `projectId` that spent `usd` on models. */
async function seedSpend(
  client: PGlite,
  projectId: string,
  usd: number,
  finishedAt: Date,
): Promise<void> {
  const set = await client.query<{ id: string }>(
    `insert into fix_eval_sets (project_id, fix_id, fix_kind, title, change, created_by, target_runs)
     values ($1, $2, 'fail-clearly', 'Other fix', '{}'::jsonb, 'user_x', 20) returning id`,
    [projectId, `issue:${crypto.randomUUID()}`],
  );
  await client.query(
    `insert into fix_eval_runs (set_id, project_id, trigger, requested_by, status, created_at, finished_at, spend)
     values ($1, $2, 'manual', 'user_x', 'completed', $3, $3, $4::jsonb)`,
    [
      set.rows[0]!.id,
      projectId,
      finishedAt,
      JSON.stringify({
        usd,
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        capUsd: 1.1,
        capped: false,
        models: ["claude-opus-5-5"],
      }),
    ],
  );
}

/** The local stand-ins, counting every call made to any of them. */
function countingModels(): { models: EvalModels; calls: () => number } {
  const base = standInModels();
  let calls = 0;
  const counted = <T>(value: T): T => {
    calls += 1;
    return value;
  };
  const models: EvalModels = {
    ...base,
    agent: (context) => {
      const agent = base.agent!(context);
      return agent && { ...agent, next: (input) => counted(agent.next(input)) };
    },
    tool: base.tool && {
      ...base.tool,
      answer: (input) => counted(base.tool!.answer(input)),
    },
    judge: base.judge && {
      ...base.judge,
      judge: (input) => counted(base.judge!.judge(input)),
    },
  };
  return { models, calls: () => calls };
}

/** "Make hold_fare fail clearly": an issue's own fix, pointed at this project's issue. */
function failClearlyFix(): Fix {
  const base = buildFixes(fixesInput()).open[0]!;
  return {
    ...base,
    id: `issue:${ISSUE}`,
    source: "issue",
    sourceId: ISSUE,
    aliases: [],
    kind: "fail-clearly",
    short: "Make it fail clearly",
    title: "Make hold_fare fail clearly",
    subject: {
      ...base.subject,
      tools: [{ id: "hold_fare", label: "hold_fare", href: "" }],
      tasks: [],
    },
    issues: [
      {
        id: ISSUE,
        kind: "identical_retry",
        title: "Retries hold_fare with the same input",
        claim: "",
        cost: "",
        figure: null,
        href: `/project/${PROJECT}/health#signal-${ISSUE}`,
      },
    ],
    detail: {
      source: "issue",
      changes: ["Make hold_fare say why it failed and whether a retry can help."],
      caveat: null,
    },
  };
}

function deps(db: Db, fix: Fix, models = standInModels()): Partial<EvalGateDeps> {
  return {
    db,
    loadFix: async (projectId, id) =>
      projectId === PROJECT && id === fix.id ? { projectId, fix } : null,
    loadCorpus: async () => [],
    enqueue: async () => null,
    models,
  };
}

test('a behavioral fix with no model configured reads "can\'t simulate", never the old by-construction 100%', async () => {
  const { client, db } = await setup();
  const lines: Record<string, unknown>[] = [];
  const restore = setModelCallSink({
    info: (fields, message) => message === "model_call" && lines.push(fields),
    warn: () => {},
  });
  try {
    const fix = failClearlyFix();
    const outcome = await runSimulation(fix.id, {
      projectId: PROJECT,
      deps: deps(db, fix, { agent: null, tool: null, judge: null, standIn: false }),
    });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.verdict, "unsupported");
    assert.equal(outcome.nSimulated, 0);
    assert.equal(outcome.methods?.none, 4);
    assert.deepEqual(outcome.methods?.reasons, [{ note: CANT_SIMULATE.noModel, runs: 4 }]);
    assert.equal(outcome.spend, null, "nothing was called");
    // The six runs it couldn't replay (four holdout, two evidence) are one `model_call` line, not six.
    assert.deepEqual(
      lines.map((line) => [line.feature, line.outcome, line.calls]),
      [["eval_gate_replay", "skipped_no_key", 6]],
    );
  } finally {
    restore();
    await client.close();
  }
});

test("over the organization's daily budget, the runs say so and no model is called", async () => {
  const { client, db } = await setup();
  try {
    const fix = failClearlyFix();
    // A second project of the same organization already spent $9.50 today; another organization's spend doesn't count.
    await client.exec(`
      insert into organizations (id, name, slug) values ('${OTHER_ORG}', 'Other', 'other');
      insert into projects (id, organization_id, name, slug) values ('${SIBLING}', '${ORG}', 'Sibling', 'sibling'), ('${STRANGER}', '${OTHER_ORG}', 'Stranger', 'stranger');
    `);
    await seedSpend(client, SIBLING, 9.5, at(60));
    await seedSpend(client, STRANGER, 50, at(60));
    // Spend older than a day is forgotten.
    await seedSpend(client, SIBLING, 50, new Date(NOW.getTime() - 25 * 60 * 60_000));

    const counted = countingModels();
    const outcome = await runSimulation(fix.id, {
      projectId: PROJECT,
      deps: { ...deps(db, fix, counted.models), dailyBudgetUsd: 10, now: () => NOW },
    });
    assert.equal(outcome.status, "completed");
    assert.ok(counted.calls() > 0, "under the budget the replay runs");

    await seedSpend(client, SIBLING, 0.5, at(30));
    const spent = countingModels();
    const blocked = await runSimulation(fix.id, {
      projectId: PROJECT,
      deps: { ...deps(db, fix, spent.models), dailyBudgetUsd: 10, now: () => NOW },
    });
    assert.equal(blocked.status, "completed");
    assert.equal(spent.calls(), 0, "nothing is called");
    assert.equal(blocked.nSimulated, 0);
    assert.deepEqual(blocked.methods?.reasons, [{ note: CANT_SIMULATE.dailyBudget, runs: 4 }]);
    assert.equal(blocked.spend, null);
  } finally {
    await client.close();
  }
});

test("model replay: held-out runs replayed with and without the fix, scored with the targeted and the outcome checks", async () => {
  const { client, db } = await setup();
  try {
    const fix = failClearlyFix();
    const outcome = await runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix) });
    assert.equal(outcome.status, "completed");

    const set = (await getEvalSet(PROJECT, fix.id, db))!;
    const cases = await listCases(set.id, db);
    assert.deepEqual(
      cases.map((item) => [item.turnId, item.origin]),
      [
        [turnId(6), "tool"],
        [turnId(5), "tool"],
        [turnId(4), "tool"],
        [turnId(3), "tool"],
        [turnId(2), "issue"],
        [turnId(1), "issue"],
      ],
    );
    // Drafted for a replayed kind: the targeted check plus how the run ends.
    const drafted = cases.find((item) => item.turnId === turnId(3))!.expected;
    assert.equal(drafted.maxFailedCalls, 1);
    assert.equal(drafted.endsWell, true);
    assert.equal(drafted.maxSelfCorrections, 3);
    assert.ok(drafted.maxCostUsd && drafted.maxCostUsd > 0.01);

    // Runs 3 to 5 replayed; run 6 has no stored prompts.
    assert.deepEqual(outcome.methods && [outcome.methods.replay, outcome.methods.none], [3, 1]);
    assert.deepEqual(outcome.methods?.reasons, [{ note: CANT_SIMULATE.noPrompts, runs: 1 }]);
    assert.deepEqual(outcome.methods?.fidelity, { matched: 3, total: 3 });
    // Runs 3 and 4 stop failing over and over, but still end on the failure; run 5 holds the fare on both sides.
    assert.deepEqual(
      [outcome.before?.passed, outcome.after?.passed, outcome.nSimulated],
      [1, 1, 3],
    );
    assert.deepEqual(
      outcome.evidence && [
        outcome.evidence.nSimulated,
        outcome.evidence.before.passed,
        outcome.evidence.after.passed,
      ],
      [2, 0, 0],
    );
    assert.ok(
      outcome.spend &&
        outcome.spend.calls > 0 &&
        outcome.spend.models.includes("stand-in-model-local"),
    );

    // Owned (ADR-0030): read through the store; `db/tables` has no relational reader for this table.
    const run = await getEvalRun(outcome.runId, db);
    const results = parseResults(run?.results);
    const three = results.find((item) => item.turnId === turnId(3))!;
    assert.equal(three.method, "replay");
    assert.deepEqual(three.replay?.paths, {
      recorded: ["hold_fare", "hold_fare", "hold_fare"],
      before: ["hold_fare", "hold_fare", "hold_fare"],
      after: ["hold_fare"],
    });
    const after = Object.fromEntries(three.after!.checks.map((check) => [check.kind, check.pass]));
    assert.equal(after.max_failed_calls, true);
    assert.equal(after.ends_well, false);
    assert.ok(!JSON.stringify(results).includes("Hold the fare"), "no text from the run is stored");

    const page = await loadEvalGatePage(PROJECT, fix.id, fix, db);
    assert.equal(page.latest?.method, "replay");
    assert.equal(page.latest?.replay, true);
    assert.equal(page.latest?.breakdown?.target.after.passed, 3);
    assert.equal(page.latest?.breakdown?.outcome.after.passed, 1);
    assert.ok(page.set?.replayChange[0]?.includes("hold_fare fails"));
    assert.equal(
      page.cases.find((item) => item.turnId === turnId(6))?.methodNote,
      CANT_SIMULATE.noPrompts,
    );
    const badge = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(badge?.state === "done" && badge.method, "replay");
  } finally {
    await client.close();
  }
});

test("RC-76: a replay that leaves the recorded path is stored with what it did, not scored, and the page shows both paths", async () => {
  const { client, db } = await setup();
  try {
    const fix = failClearlyFix();
    const base = standInModels();
    // Run 5 (one hold_fare, held at once): without the fix, the model hands over to a person instead.
    const models: EvalModels = {
      ...base,
      agent: (context) => {
        if (context.recorded.length !== 1) return base.agent!(context);
        let step = 0;
        return {
          model: "stand-in-model-local",
          standIn: true,
          next: async () => ({
            text: step++ === 0 ? "" : "Passed on.",
            calls: step === 1 ? [{ id: "x1", name: "escalate_to_agent", args: {} }] : [],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
            model: "stand-in-model-local",
          }),
        };
      },
    };
    const outcome = await runSimulation(fix.id, {
      projectId: PROJECT,
      deps: deps(db, fix, models),
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.methods?.fidelity, { matched: 2, total: 3 });
    assert.equal(outcome.nSimulated, 2);

    // Owned (ADR-0030): read through the store; `db/tables` has no relational reader for this table.
    const run = await getEvalRun(outcome.runId, db);
    const five = parseResults(run?.results).find((item) => item.turnId === turnId(5))!;
    assert.deepEqual(
      [five.simulated, five.skipped, five.methodNote, five.replayFailed],
      [false, "cant-simulate", CANT_SIMULATE.drifted, true],
    );
    assert.deepEqual(five.replay?.paths, {
      recorded: ["hold_fare"],
      before: ["escalate_to_agent"],
      after: [],
    });
    assert.deepEqual(five.replay?.stops, { before: "answered", after: "not-run" });

    const page = await loadEvalGatePage(PROJECT, fix.id, fix, db);
    const row = (n: number) => page.cases.find((item) => item.turnId === turnId(n))!;
    assert.deepEqual(row(5).replayPaths, {
      recorded: ["hold_fare"],
      before: ["escalate_to_agent"],
      after: null,
      intended: null,
      doesTheWork: null,
      workDetail: null,
      baseline: false,
      stops: { before: "Answered", after: "Not replayed: no baseline" },
    });
    assert.deepEqual(row(3).replayPaths?.after, ["hold_fare"]);
    assert.equal(row(3).replayPaths?.baseline, true);
    assert.equal(row(6).replayPaths, null, "never replayed: no stored prompts");
  } finally {
    await client.close();
  }
});

/* - Owned (ADR-0030): nothing calls out without a model key ------------------- */

/** Runs `run` with the network cut: any `fetch` is recorded and refused. */
async function withNoNetwork<T>(run: () => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    assert.deepEqual(calls, [], "the eval gate may not reach the network without a model key");
  }
}

const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };

test("with no model key a simulation completes, says it can't replay, and never reaches the network", async () => {
  const { client, db } = await setup();
  try {
    const fix = failClearlyFix();
    const models = resolveEvalModels(NO_KEYS, undefined, "production");
    const outcome = await withNoNetwork(() =>
      runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix, models) }),
    );
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.verdict, "unsupported");
    assert.equal(outcome.nSimulated, 0);
    assert.deepEqual(outcome.methods?.reasons, [{ note: CANT_SIMULATE.noModel, runs: 4 }]);
    assert.equal(outcome.spend, null, "nothing was called");
    const run = await getEvalRun(outcome.runId, db);
    assert.equal(run?.status, "completed", "the run is stored");
  } finally {
    await client.close();
  }
});

test("with EVAL_GATE_MOCK_MODEL=1 a simulation runs on the stand-ins, with no network and no cost", async () => {
  const { client, db } = await setup();
  try {
    const fix = failClearlyFix();
    const models = resolveEvalModels(
      { ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" },
      undefined,
      "development",
    );
    const outcome = await withNoNetwork(() =>
      runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix, models) }),
    );
    assert.equal(outcome.status, "completed");
    assert.ok(outcome.nSimulated > 0, "the stand-ins replayed the runs");
    assert.ok(outcome.spend?.models.includes("stand-in-model-local"));
    assert.equal(outcome.spend?.usd, 0);
  } finally {
    await client.close();
  }
});
