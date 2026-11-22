import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  type AgentModel,
  echoToolStandIn,
  type PersonModel,
  type ReplayMessage,
  ruleJudge,
  SpendMeter,
  STAND_IN_MODEL,
} from "@/lib/views/eval-gate/models";
import type { RunRecord, ToolDef } from "@/lib/views/eval-gate/types";
import type { Scorer } from "@/lib/views/task-scorers/types";
import type { EvalTurn } from "../domain/types";
import type { EvalReplay } from "../job";
import { type EvalTurnsDeps, runEvalTurns } from "../turns";

/* - fixtures ------------------------------------------------------------------ */

const MAP = { ref: "R1" };
const SELECT = { ref: "R1", seat: "23A" };
const MAX_TWO: Scorer[] = [{ kind: "max_tool_calls", max: 2 }];

function seatReplay(): EvalReplay {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const steps = [
    { name: "get_seat_map", args: MAP, result: { free: ["23A"] } },
    { name: "select_seat", args: SELECT, result: { seat: "23A" } },
  ];
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: steps.map(({ name }) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
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
    content: [{ type: "text", text: "Seat 23A is yours." }],
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
  const run: RunRecord = {
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
    durationMs: 4000,
    costUsd: 0.009,
    answered: true,
  };
  return { run, calls };
}

type Step = { name: string; args: Record<string, unknown> }[];

/** A fake agent per turn: `plan(turn, lastPersonMessage)` gives its tool calls, one per model call, then it answers. Keeps every first input it was given. */
function fakeAgents(plan: (turn: number, said: string) => Step, seen: ReplayMessage[][]) {
  let turn = 0;
  return () => {
    const mine = turn;
    turn += 1;
    let n = 0;
    let steps: Step | null = null;
    const agent: AgentModel = {
      model: STAND_IN_MODEL,
      standIn: true,
      async next({ messages }) {
        if (n === 0) seen.push([...messages]);
        const said =
          [...messages]
            .reverse()
            .find(
              (message): message is Extract<ReplayMessage, { role: "user" }> =>
                message.role === "user",
            )?.text ?? "";
        steps ??= plan(mine, said);
        const step = steps[n];
        n += 1;
        const calls = step ? [{ id: `a${mine}_${n}`, name: step.name, args: step.args }] : [];
        return {
          text: calls.length === 0 ? `Reply to: ${said}` : "",
          calls,
          usage: { inputTokens: 100, outputTokens: 10 },
          latencyMs: 5,
          model: STAND_IN_MODEL,
        };
      },
    };
    return agent;
  };
}

function fakePerson(said: string[], model = "claude-haiku-4-5"): PersonModel {
  return {
    model,
    standIn: false,
    async write({ description, messages }) {
      said.push(`${description} | after ${messages.length} messages`);
      return {
        text: `As ${description}: and a window seat?`,
        usage: { inputTokens: 300, outputTokens: 20 },
      };
    },
  };
}

function deps(
  agent: () => AgentModel,
  person: PersonModel | null,
  spend = new SpendMeter(5),
  keepText = false,
): EvalTurnsDeps {
  return {
    replay: {
      models: { agent, tool: echoToolStandIn(), judge: ruleJudge(), standIn: true },
      spend,
      maxSteps: 8,
      toolDefs: new Map<string, ToolDef>(),
      budgetNote: CANT_SIMULATE.budget,
      trace: { keepText },
    },
    person,
    scorers: MAX_TWO,
  };
}

const eval_ = (turns: EvalTurn[]) => ({ earlierMessages: [], fixedAnswers: [], turns });
const RECORDED: Step = [
  { name: "get_seat_map", args: MAP },
  { name: "select_seat", args: SELECT },
];

/* - tests ------------------------------------------------------------------- */

test("RC-296: an eval without turns runs once, as today: no turns, no attempts", async () => {
  const result = await runEvalTurns(
    eval_([]),
    seatReplay(),
    deps(
      fakeAgents(() => RECORDED, []),
      null,
    ),
  );
  assert.equal(result.passed, true);
  assert.equal(result.turns, null);
  assert.equal(result.attempts, null);
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(
    result.toolAnswers.map((answer) => answer.source),
    ["recorded", "recorded"],
  );
});

test("RC-296: two fixed turns replay in order, each with the conversation so far, and each is scored", async () => {
  const seen: ReplayMessage[][] = [];
  // The second follow-up makes three calls: over the limit of two.
  const plan = (turn: number): Step =>
    turn === 0
      ? RECORDED
      : turn === 1
        ? [{ name: "get_seat_map", args: MAP }]
        : [...RECORDED, { name: "get_seat_map", args: MAP }];
  const result = await runEvalTurns(
    eval_([
      { kind: "message", text: "Is it a window?" },
      { kind: "message", text: "Then 24A." },
    ]),
    seatReplay(),
    deps(fakeAgents(plan, seen), null, new SpendMeter(5), true),
  );
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[1]!.at(-1), { role: "user", text: "Is it a window?" });
  assert.ok(
    seen[1]!.some(
      (message) => message.role === "assistant" && message.text === "Reply to: Pick seat 23A on R1",
    ),
    "Turn 2 sees turn 1's reply.",
  );
  assert.deepEqual(seen[2]!.at(-1), { role: "user", text: "Then 24A." });
  assert.deepEqual(
    result.turns!.map((turn) => [turn.message, turn.simulated, turn.passed, turn.answers]),
    [
      ["Pick seat 23A on R1", false, true, 2],
      ["Is it a window?", false, true, 1],
      ["Then 24A.", false, false, 3],
    ],
  );
  assert.equal(result.passed, false, "Every turn must pass.");
  assert.deepEqual(
    result.verdicts.map((verdict) => [verdict.kind, verdict.status, verdict.measured]),
    [["max_tool_calls", "fail", 3]],
    "The failing turn's verdicts.",
  );
  assert.equal(result.toolCalls, 6);
  assert.equal(result.toolAnswers.length, 6);
  assert.equal(result.attempts, null, "Fixed turns run once.");
});

test("RC-296: without the content opt-in the turns keep no words", async () => {
  const result = await runEvalTurns(
    eval_([{ kind: "message", text: "Is it a window?" }]),
    seatReplay(),
    deps(
      fakeAgents(() => RECORDED, []),
      null,
    ),
  );
  assert.deepEqual(
    result.turns!.map((turn) => turn.message),
    [null, null],
  );
  assert.equal(result.transcript, null);
});

test("RC-296: a simulated turn is written from the description and the conversation; the eval runs 3 times and reports a pass rate", async () => {
  const said: string[] = [];
  const seen: ReplayMessage[][] = [];
  let attempt = -1;
  // Turn 0 of each attempt is the recorded ask; the second attempt's simulated turn goes over the limit.
  const plan = (turn: number): Step => {
    if (turn % 2 === 0) {
      attempt += 1;
      return RECORDED;
    }
    return attempt === 1
      ? [...RECORDED, { name: "get_seat_map", args: MAP }]
      : [{ name: "get_seat_map", args: MAP }];
  };
  const result = await runEvalTurns(
    eval_([{ kind: "person", description: "an impatient traveler" }]),
    seatReplay(),
    deps(fakeAgents(plan, seen), fakePerson(said)),
  );
  assert.deepEqual(said, Array(3).fill("an impatient traveler | after 6 messages"));
  assert.deepEqual(seen[1]!.at(-1), {
    role: "user",
    text: "As an impatient traveler: and a window seat?",
  });
  assert.deepEqual(result.attempts, { passed: 2, total: 3 });
  assert.equal(result.passed, false, "Passes only when every run passes.");
  assert.deepEqual(
    result.turns!.map((turn) => [turn.simulated, turn.passed]),
    [
      [false, true],
      [true, false],
    ],
    "The failing run is the one shown.",
  );
});

test("RC-296: the simulated person's spend counts against the reservation, and a refused call stops the eval", async () => {
  const spend = new SpendMeter(1);
  const result = await runEvalTurns(
    eval_([{ kind: "person", description: "a traveler" }]),
    seatReplay(),
    deps(
      fakeAgents(() => RECORDED, []),
      fakePerson([]),
      spend,
    ),
  );
  assert.ok(spend.usd > 0, "The agent here is free: what was spent is the person's.");
  assert.ok(spend.models.has("claude-haiku-4-5"));
  assert.equal(result.attempts!.total, 3);

  const said: string[] = [];
  const broke = new SpendMeter(0.000_001);
  const refused = await runEvalTurns(
    eval_([{ kind: "person", description: "a traveler" }]),
    seatReplay(),
    deps(
      fakeAgents(() => RECORDED, []),
      fakePerson(said),
      broke,
    ),
  );
  assert.deepEqual(said, [], "Refused before the call.");
  assert.equal(refused.error, CANT_SIMULATE.budget);
  assert.equal(refused.passed, null);
  assert.equal(broke.usd, 0);
});

test("RC-296: a simulated turn with no model to play the person says so", async () => {
  const result = await runEvalTurns(
    eval_([{ kind: "person", description: "a traveler" }]),
    seatReplay(),
    deps(
      fakeAgents(() => RECORDED, []),
      null,
    ),
  );
  assert.equal(result.passed, null);
  assert.match(result.error ?? "", /simulated person/i);
});
