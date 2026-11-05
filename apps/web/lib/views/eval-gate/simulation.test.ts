import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "./calls";
import { emptyChange } from "./change";
import { CANT_SIMULATE } from "./method";
import { type EvalModels, scriptedAgent } from "./models";
import { type SimulationCase, simulateCases } from "./simulation";
import { NO_EXPECTATION } from "./types";

test("simulateCases scores prepared cases without an eval set and keeps evidence separate", async () => {
  const item = preparedCase();
  const result = await simulateCases(
    [item, { ...item, id: "evidence", role: "evidence" }, { ...item, id: "gone", run: null }],
    {
      ...emptyChange(),
      kind: "rewrite",
      patches: { get_order: "order status" },
      ranker: { before: () => ["notify", "get_order"], after: () => ["get_order", "notify"] },
    },
    { agent: null, tool: null, judge: null, standIn: false },
    { dailyLeftUsd: 5 },
  );

  assert.deepEqual(
    result.results.map((row) => [row.caseId, row.role, row.method, row.skipped]),
    [
      ["case-1", "holdout", "rerank", null],
      ["evidence", "evidence", "rerank", null],
      ["gone", "holdout", "none", "run-gone"],
    ],
  );
  assert.equal(result.results[0]!.before!.rank, 2);
  assert.equal(result.results[0]!.after!.rank, 1);
  assert.deepEqual(result.methods, { rerank: 1, replay: 0, none: 1, reasons: [], fidelity: null });
  assert.equal(result.method, "rerank");
  assert.equal(result.spend, null);
  assert.deepEqual(result.judge, { readings: new Map(), status: { status: "no-criteria" } });
});

test("simulateCases returns replay facts, paired judgments and combined model spend", async () => {
  const item = replayCase();
  const model = "claude-sonnet-4-6";
  const result = await simulateCases(
    [item],
    {
      ...emptyChange(),
      kind: "fail-clearly",
      dedupeRetries: ["get_order"],
      replay: { tools: [], failClearly: ["get_order"], prerequisite: null, skill: null },
    },
    {
      agent: ({ recorded }) => scriptedAgent(recorded, model),
      tool: null,
      judge: {
        model,
        standIn: false,
        judge: async () => ({ pass: false, usage: { inputTokens: 1000, outputTokens: 100 } }),
      },
      standIn: false,
    },
    { dailyLeftUsd: 0.1, replayUsd: 0.1, judgeUsd: 0.1 },
  );

  assert.equal(result.results[0]!.method, "replay");
  assert.deepEqual(result.results[0]!.replay?.paths, {
    recorded: ["get_order"],
    before: ["get_order"],
    after: ["get_order"],
  });
  assert.deepEqual(result.methods, {
    rerank: 0,
    replay: 1,
    none: 0,
    reasons: [],
    fidelity: { matched: 1, total: 1 },
  });
  assert.deepEqual(result.judge, {
    readings: new Map([[item.id, { before: false, after: false }]]),
    status: { status: "judged", model, runs: 1 },
  });
  const criteria = result.results[0]!.after!.checks.find((check) => check.kind === "criteria");
  assert.equal(criteria?.pass, false);
  assert.equal(criteria?.measured, true);
  assert.ok(result.spend);
  assert.equal(result.spend.calls, 6);
  assert.equal(result.spend.inputTokens, 2400);
  assert.equal(result.spend.outputTokens, 240);
  assert.ok(Math.abs(result.spend.usd - 0.0108) < 1e-9);
  assert.ok(Math.abs(result.spend.capUsd - 0.1982) < 1e-9);
  assert.equal(result.spend.capped, false);
  assert.deepEqual(result.spend.models, [model]);
});

test("simulateCases blocks replay and judging when the daily budget is exhausted", async () => {
  const item = replayCase();
  const models: EvalModels = {
    agent: () => ({
      model: "claude-sonnet-4-6",
      standIn: false,
      next: async () => assert.fail("The replay must not call the model."),
    }),
    tool: null,
    judge: {
      model: "claude-sonnet-4-6",
      standIn: false,
      judge: async () => assert.fail("The judge must not call the model."),
    },
    standIn: false,
  };
  const replay = await simulateCases(
    [item],
    {
      ...emptyChange(),
      kind: "fail-clearly",
      dedupeRetries: ["get_order"],
      replay: { tools: [], failClearly: ["get_order"], prerequisite: null, skill: null },
    },
    models,
    { dailyLeftUsd: 0 },
  );
  assert.equal(replay.results[0]!.skipped, "cant-simulate");
  assert.equal(replay.results[0]!.methodNote, CANT_SIMULATE.dailyBudget);
  assert.deepEqual(replay.methods.reasons, [{ note: CANT_SIMULATE.dailyBudget, runs: 1 }]);
  assert.equal(replay.spend, null);

  const rerank = await simulateCases(
    [{ ...preparedCase(), criteria: "Find the order." }],
    { ...emptyChange(), kind: "fewer-results", topK: 1 },
    models,
    { dailyLeftUsd: 0 },
  );
  assert.equal(rerank.results[0]!.method, "rerank");
  assert.deepEqual(rerank.judge.status, {
    status: "budget",
    model: "claude-sonnet-4-6",
    runs: 0,
    skipped: 1,
  });
  assert.deepEqual(rerank.judge.readings.get(item.id), { before: null, after: null });
  assert.equal(rerank.spend, null);
});

test("task criteria produce their own paired scores without changing fix criteria", async () => {
  const item = {
    ...preparedCase(),
    criteria: "Fix criteria.",
    scorers: [{ kind: "judge_criteria" as const, criteria: "Task criteria." }],
  };
  const seen: string[] = [];
  const result = await simulateCases(
    [item],
    { ...emptyChange(), kind: "fewer-results", topK: 1 },
    {
      agent: null,
      tool: null,
      standIn: false,
      judge: {
        model: "claude-sonnet-4-6",
        standIn: false,
        judge: async ({ criteria, run }) => {
          seen.push(criteria);
          return {
            pass:
              criteria === "Task criteria." &&
              run.includes("first search listed: notify, get_order"),
            usage: { inputTokens: 100, outputTokens: 10 },
          };
        },
      },
    },
    { dailyLeftUsd: 1 },
  );
  assert.deepEqual(seen.sort(), [
    "Fix criteria.",
    "Fix criteria.",
    "Task criteria.",
    "Task criteria.",
  ]);
  assert.equal(result.scorerResults?.[0]?.before[0]?.status, "pass");
  assert.equal(result.scorerResults?.[0]?.after[0]?.status, "fail");
  assert.equal(
    result.results[0]?.before?.checks.find((check) => check.kind === "criteria")?.pass,
    false,
  );
  assert.equal(result.spend?.calls, 4);
});

test("a task criterion alone determines the simulation result", async () => {
  const item = {
    ...preparedCase(),
    expected: { ...NO_EXPECTATION },
    scorers: [{ kind: "judge_criteria" as const, criteria: "Keep get_order in the list." }],
  };
  const result = await simulateCases(
    [item],
    { ...emptyChange(), kind: "fewer-results", topK: 1 },
    {
      agent: null,
      tool: null,
      standIn: false,
      judge: {
        model: "claude-sonnet-4-6",
        standIn: false,
        judge: async ({ run }) => ({
          pass: run.includes("first search listed: notify, get_order"),
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
      },
    },
    { dailyLeftUsd: 1 },
  );
  assert.equal(result.results[0]?.simulated, true);
  assert.equal(result.results[0]?.before?.pass, true);
  assert.equal(result.results[0]?.after?.pass, false);
});

function preparedCase(): SimulationCase {
  return {
    id: "case-1",
    turnId: "turn-1",
    traceId: null,
    origin: "task",
    originRef: null,
    expected: { ...NO_EXPECTATION, tool: "get_order" },
    outcome: "",
    criteria: "",
    position: 0,
    role: "holdout",
    run: {
      turnId: "turn-1",
      traceId: null,
      startedAt: "2026-11-01T12:00:00.000Z",
      taskId: "orders",
      steps: [
        {
          kind: "search",
          ordinal: 1,
          query: "order status",
          hitIds: ["notify", "get_order"],
          topK: 2,
        },
        { kind: "invoke", ordinal: 2, targetId: "get_order", outcome: "ok" },
      ],
    },
  };
}

function replayCase(): SimulationCase {
  const item = preparedCase();
  const user: CloudMessage = { role: "user", content: "Find the order." };
  const call: CloudMessage = {
    role: "assistant",
    content: [{ type: "tool_call", id: "call-1", name: "get_order", arguments: {} }],
  };
  const messages: CloudMessage[] = [
    user,
    call,
    { role: "tool", tool_call_id: "call-1", content: '{"error":"order not found"}' },
    { role: "assistant", content: "The order is unavailable." },
  ];
  const first: ModelCall = {
    turnId: item.turnId,
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
    model: "claude-sonnet-4-6",
    finishReason: "tool_call",
    costUsd: 0.003,
    latencyMs: 100,
    inputTokens: 100,
    outputTokens: 10,
    payload: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      ts: "2026-11-01T12:00:00.000Z",
      tools: [
        {
          name: "get_order",
          description: "Find an order.",
          parameters: { type: "object", properties: {} },
        },
      ],
      messages: [user, call],
    },
  };
  return {
    ...item,
    expected: { ...NO_EXPECTATION, maxFailedCalls: 1 },
    criteria: "Finish with a valid order.",
    run: {
      ...item.run!,
      steps: [{ kind: "invoke", ordinal: 1, targetId: "get_order", outcome: "error" }],
    },
    calls: [first, { ...first, finishReason: "stop", payload: { ...first.payload!, messages } }],
  };
}
