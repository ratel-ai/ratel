import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "./calls";
import { type AgentModel, type ReplayMessage, SpendMeter, standInModels } from "./models";
import { type ReplayDeps, replayAsRecorded, type ToolMock } from "./replay";
import type { RunRecord, ToolDef } from "./types";

/* - fixtures ------------------------------------------------------------------ */

const MAP = { ref: "R1", flight: "F1" };
const SELECT = { ref: "R1", seat: "23A" };

/** A run that read the seat map, picked 23A and answered. */
function seatRun(): { run: RunRecord; calls: ModelCall[] } {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: ["get_seat_map", "select_seat"].map((name) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
  const steps = [
    { name: "get_seat_map", args: MAP, result: { free: ["23A"] } },
    { name: "select_seat", args: SELECT, result: { seat: "23A" } },
  ];
  const conversation: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Pick seat 23A on R1" }] },
  ];
  const calls: ModelCall[] = [];
  steps.forEach((step, index) => {
    const output: CloudMessage = {
      role: "assistant",
      content: [{ type: "tool_call", id: `toolu_${index}`, name: step.name, arguments: step.args }],
    };
    calls.push({
      turnId: "t1",
      occurredAt: at(index * 2),
      model: "claude-sonnet-4-6",
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900,
      outputTokens: 30,
      payload: payload([...conversation, output], "tool_call"),
    });
    conversation.push(output, {
      role: "tool",
      tool_call_id: `toolu_${index}`,
      content: JSON.stringify(step.result),
    });
  });
  const answer: CloudMessage = {
    role: "assistant",
    content: [{ type: "text", text: "All done." }],
  };
  calls.push({
    turnId: "t1",
    occurredAt: at(4),
    model: "claude-sonnet-4-6",
    finishReason: "stop",
    costUsd: 0.003,
    latencyMs: 800,
    inputTokens: 900,
    outputTokens: 30,
    payload: payload([...conversation, answer], "stop"),
  });
  return {
    run: {
      turnId: "t1",
      traceId: "trace-1",
      startedAt: at(0).toISOString(),
      endedAt: at(4).toISOString(),
      taskId: null,
      steps: steps.map((step, index) => ({
        kind: "invoke",
        ordinal: index + 1,
        targetId: step.name,
        outcome: "ok",
      })),
      durationMs: 10_000,
      costUsd: 0.015,
      answered: true,
    },
    calls,
  };
}

/** Plays `steps` in order and keeps what each model call was given. */
function scripted(
  steps: { name: string; args: Record<string, unknown> }[][],
  seen: ReplayMessage[][] = [],
): AgentModel {
  let n = 0;
  return {
    model: "claude-sonnet-4-6",
    standIn: false,
    async next({ messages }) {
      seen.push([...messages]);
      const calls = (steps[n] ?? []).map((step, i) => ({
        id: `s${n}_${i}`,
        name: step.name,
        args: step.args,
      }));
      n += 1;
      return {
        text: calls.length === 0 ? "Seat 23A is yours." : "",
        calls,
        usage: { inputTokens: 100, outputTokens: 10 },
        latencyMs: 5,
        model: "claude-sonnet-4-6",
      };
    },
  };
}

function deps(agent: AgentModel): ReplayDeps {
  return {
    models: { ...standInModels(), standIn: false, agent: () => agent },
    spend: new SpendMeter(5),
    maxSteps: 8,
    toolDefs: new Map<string, ToolDef>(),
    trace: { keepText: true },
  };
}

const RECORDED_PATH = [
  [{ name: "get_seat_map", args: MAP }],
  [{ name: "select_seat", args: SELECT }],
  [],
];
const FULL: ToolMock = {
  tool: "get_seat_map",
  when: { flight: "F1" },
  content: JSON.stringify({ free: [] }),
  isError: false,
  why: "The plane is full",
};

/* - tests ------------------------------------------------------------------- */

test("RC-295: a fixed answer matching the tool and its condition answers first, with source mock and its reason", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)), {
    mocks: [FULL],
  });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  const [first, second] = outcome.trace!.answers;
  assert.equal(first!.source, "mock");
  assert.equal(first!.reason, "fixed_answer");
  assert.equal(first!.why, "The plane is full");
  assert.deepEqual(JSON.parse(first!.result!), { free: [] });
  // A fixed answer is not used up: the next call is answered as before.
  assert.equal(second!.source, "recorded");
});

test("RC-295: a fixed answer with no condition answers every call of its tool, and an error answer counts as failed", async () => {
  const { run, calls } = seatRun();
  const down: ToolMock = {
    tool: "select_seat",
    content: JSON.stringify({ error: "seat service down" }),
    isError: true,
  };
  const outcome = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)), {
    mocks: [down],
  });
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.trace!.answers.map((answer) => answer.source),
    ["recorded", "mock"],
  );
  assert.deepEqual(outcome.view.outcomes, ["ok", "error"]);
  assert.equal("why" in outcome.trace!.answers[1]!, false);
});

test("RC-295: a fixed answer whose tool or condition doesn't match falls through to the recording", async () => {
  const { run, calls } = seatRun();
  const mocks: ToolMock[] = [
    { ...FULL, when: { flight: "F9" } },
    { ...FULL, tool: "cancel_booking", when: undefined },
  ];
  const outcome = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)), { mocks });
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.trace!.answers.map((answer) => answer.source),
    ["recorded", "recorded"],
  );
});

test("RC-295: earlier messages reach the first model call before the recording's history, and are not scored", async () => {
  const { run, calls } = seatRun();
  const history: ReplayMessage[] = [
    { role: "user", text: "Hi, I'm Ana on booking R1" },
    {
      role: "assistant",
      text: "",
      calls: [{ id: "e1", name: "find_booking", args: { ref: "R1" } }],
    },
    {
      role: "tool",
      callId: "e1",
      content: JSON.stringify({ booking: "R1", name: "Ana" }),
      isError: false,
    },
    { role: "assistant", text: "Found your booking, Ana.", calls: [] },
  ];
  const seen: ReplayMessage[][] = [];
  const path = [[{ name: "find_booking", args: { ref: "R1" } }], ...RECORDED_PATH];
  const outcome = await replayAsRecorded(run, calls, deps(scripted(path, seen)), { history });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(seen[0], [...history, { role: "user", text: "Pick seat 23A on R1" }]);
  // The earlier tool call is history, not a step of the replay; a re-read of it is answered as it was.
  assert.deepEqual(outcome.view.calls, ["find_booking", "get_seat_map", "select_seat"]);
  assert.deepEqual(
    outcome.trace!.answers.map((answer) => answer.source),
    ["earlier", "recorded", "recorded"],
  );
  assert.equal(
    outcome.trace!.transcript!.filter(
      (step) => step.role === "assistant" && step.text === "Found your booking, Ana.",
    ).length,
    0,
  );
});

test("RC-295: without extras the outcome is exactly today's", async () => {
  const { run, calls } = seatRun();
  const plain = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)));
  const empty = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)), {
    history: [],
    mocks: [],
  });
  assert.deepEqual(empty, plain);
});

test("RC-296: `after` follows the recorded ask, and `conversation` returns what the replay added", async () => {
  const { run, calls } = seatRun();
  const turn1 = await replayAsRecorded(run, calls, deps(scripted(RECORDED_PATH)), {
    conversation: true,
  });
  assert.ok(turn1.ok);
  assert.deepEqual(
    turn1.messages!.map((message) => message.role),
    ["assistant", "tool", "assistant", "tool", "assistant"],
  );
  const after: ReplayMessage[] = [
    ...turn1.messages!,
    { role: "user", text: "Now a window seat, please" },
  ];
  const seen: ReplayMessage[][] = [];
  const turn2 = await replayAsRecorded(
    run,
    calls,
    deps(scripted([[{ name: "get_seat_map", args: MAP }], []], seen)),
    { after, conversation: true },
  );
  assert.ok(turn2.ok, turn2.ok ? "" : turn2.reason);
  assert.deepEqual(seen[0], [{ role: "user", text: "Pick seat 23A on R1" }, ...after]);
  // Only this turn's work is in its view: the first turn's calls are history.
  assert.deepEqual(turn2.view.calls, ["get_seat_map"]);
  assert.deepEqual(
    turn2.trace!.answers.map((answer) => answer.source),
    ["recorded"],
  );
  assert.deepEqual(
    turn2.messages!.map((message) => message.role),
    ["assistant", "tool", "assistant"],
  );
});
