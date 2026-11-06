import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Scorer } from "@/lib/views/task-scorers/types";
import type { ModelCall } from "./calls";
import { changeOf, emptyChange } from "./change";
import { CANT_SIMULATE } from "./method";
import {
  type AgentModel,
  type EvalModels,
  ModelRefused,
  SpendMeter,
  scriptedAgent,
  standInModels,
  toApiMessages,
} from "./models";
import { endsWellOf } from "./outcome";
import {
  answers,
  clearFailure,
  readRecording,
  replayRun,
  sameCall,
  ungroundedArgs,
} from "./replay";
import { scoreCase } from "./score";
import { type SimulationCase, simulateCases } from "./simulation";
import {
  type CaseResult,
  type FixChange,
  NO_EXPECTATION,
  type RunRecord,
  type RunStep,
  type ToolDef,
} from "./types";

/* - fixtures ------------------------------------------------------------------ */

const tool = (name: string): ToolDef => ({
  name,
  description: `${name} does its job.`,
  parameters: { type: "object", properties: { ref: { type: "string" } } },
});
const call = (id: string, name: string, args: Record<string, unknown> = { ref: "R1" }) => ({
  type: "tool_call" as const,
  id,
  name,
  arguments: args,
});
const result = (id: string, content: unknown): CloudMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify(content),
});

/**
 * One run as its model calls recorded it: the user asks, the agent calls
 * `steps` in order (each answered by its recorded result), then answers.
 * Each model call's payload is the conversation so far plus its own output.
 */
function recordedRun(
  steps: { name: string; result: unknown; args?: Record<string, unknown> }[],
  offered: string[],
  model = "claude-sonnet-4-6",
): { run: RunRecord; calls: ModelCall[] } {
  const history: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Hold the fare for booking R1" }] },
  ];
  const calls: ModelCall[] = [];
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model,
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: offered.map((name) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: { ref: { type: "string" } } },
    })),
    messages,
    finish_reason: finish,
  });
  const conversation = [...history];
  steps.forEach((step, index) => {
    const id = `toolu_${index}`;
    const output: CloudMessage = { role: "assistant", content: [call(id, step.name, step.args)] };
    calls.push({
      turnId: "t1",
      occurredAt: at(index * 2),
      model,
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900,
      outputTokens: 30,
      payload: payload([...conversation, output], "tool_call"),
    });
    conversation.push(output, result(id, step.result));
  });
  const answer: CloudMessage = {
    role: "assistant",
    content: [{ type: "text", text: "All done." }],
  };
  calls.push({
    turnId: "t1",
    occurredAt: at(steps.length * 2),
    model,
    finishReason: "stop",
    costUsd: 0.003,
    latencyMs: 800,
    inputTokens: 900,
    outputTokens: 30,
    payload: payload([...conversation, answer], "stop"),
  });
  const runSteps: RunStep[] = steps.map((step, index) => ({
    kind: "invoke",
    ordinal: index + 1,
    targetId: step.name,
    outcome:
      step.result && typeof step.result === "object" && "error" in step.result ? "error" : "ok",
  }));
  return {
    run: {
      turnId: "t1",
      traceId: "trace-1",
      startedAt: at(0).toISOString(),
      endedAt: at(steps.length * 2).toISOString(),
      taskId: null,
      steps: runSteps,
      durationMs: 10_000,
      costUsd: 0.015,
      answered: true,
    },
    calls,
  };
}

const change = (over: Partial<FixChange>): FixChange => ({ ...emptyChange(), ...over });
const FAIL = { error: "fare_no_longer_available" };
const failClearly = (name: string) =>
  change({
    dedupeRetries: [name],
    replay: { tools: [], failClearly: [name], prerequisite: null, skill: null },
  });

function deps(models: EvalModels = standInModels(), cap = 5, maxSteps = 8) {
  return { models, spend: new SpendMeter(cap), maxSteps, toolDefs: new Map<string, ToolDef>() };
}

/* - reading the recording --------------------------------------------------- */

test("a run's recording: the conversation before its first decision, every offered tool, its calls with their results", () => {
  const { run, calls } = recordedRun(
    [
      { name: "find_booking", result: { booking: "R1" } },
      { name: "hold_fare", result: { error: "fare_no_longer_available" } },
    ],
    ["find_booking", "hold_fare"],
  );
  const recording = readRecording(run, calls);
  assert.ok(recording);
  assert.equal(recording.history.length, 1);
  assert.equal(recording.system, "You are a travel agent.");
  assert.deepEqual(
    recording.tools.map((item) => item.name),
    ["find_booking", "hold_fare"],
  );
  assert.deepEqual(
    recording.calls.map((item) => [item.name, item.isError]),
    [
      ["find_booking", false],
      ["hold_fare", true],
    ],
  );
  assert.equal(recording.model, "claude-sonnet-4-6");
  // 10 s run, 2.4 s of model time over 3 calls, 2 tool calls: 3.8 s per tool call.
  assert.equal(Math.round(recording.toolMs), 3800);
  // No captured content: nothing to replay.
  assert.equal(
    readRecording(
      run,
      calls.map((item) => ({ ...item, payload: null })),
    ),
    null,
  );
});

test("a call matches the recording on the tool and its arguments, whatever their case, spacing or order", () => {
  assert.ok(
    sameCall(
      { name: "a", args: { ref: " R1 ", n: 2 } },
      { name: "a", args: { n: "2", ref: "r1" } },
    ),
  );
  assert.ok(!sameCall({ name: "a", args: { ref: "R1" } }, { name: "a", args: { ref: "R2" } }));
  assert.ok(!sameCall({ name: "a", args: {} }, { name: "b", args: {} }));
});

test("a clear failure says why, and whether trying again can help", () => {
  const permanent = JSON.parse(
    clearFailure("hold_fare", JSON.stringify({ error: "fare_no_longer_available" })),
  );
  assert.equal(permanent.retryable, false);
  assert.match(permanent.message, /Retrying won't help/);
  const transient = JSON.parse(
    clearFailure("hold_fare", JSON.stringify({ error: "upstream timeout after 8000 ms" })),
  );
  assert.equal(transient.retryable, true);
});

/* - the replay ---------------------------------------------------------------- */

test("fail clearly: the replay without the fix retries like the recording; with it, the model stops", async () => {
  const { run, calls } = recordedRun(
    [
      { name: "hold_fare", result: { error: "fare_no_longer_available" } },
      { name: "hold_fare", result: { error: "fare_no_longer_available" } },
      { name: "hold_fare", result: { error: "fare_no_longer_available" } },
    ],
    ["hold_fare", "escalate"],
  );
  const outcome = await replayRun(run, calls, failClearly("hold_fare"), deps());
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.before.calls, ["hold_fare", "hold_fare", "hold_fare"]);
  assert.deepEqual(outcome.after.calls, ["hold_fare"]);
  assert.equal(outcome.facts.controlMatchesRecording, true);
  assert.equal(outcome.facts.standIns.before + outcome.facts.standIns.after, 0);
  assert.equal(outcome.before.listKnown, false);
  assert.equal(outcome.before.searches, null);
  assert.match(outcome.note ?? "", /scripted stand-in/);

  // Scored with the same checks: fewer failed calls and self-corrections (3 → 1: giving up counts); it still ends on a failure.
  const expected = { ...NO_EXPECTATION, maxFailedCalls: 1, endsWell: true, maxSelfCorrections: 1 };
  const scored = scoreCase(
    { id: "c1", turnId: "t1", expected },
    { before: outcome.before, after: outcome.after, skipped: null, reranked: false },
    failClearly("hold_fare"),
  );
  const reading = (side: CaseResult["after"]) =>
    Object.fromEntries(side!.checks.map((check) => [check.kind, check.pass]));
  assert.deepEqual(reading(scored.before), {
    max_failed_calls: false,
    ends_well: false,
    max_self_corrections: false,
  });
  assert.deepEqual(reading(scored.after), {
    max_failed_calls: true,
    ends_well: false,
    max_self_corrections: true,
  });
});

test("fail clearly on a transient failure: the model is told to try once more, and the recording answers the retry", async () => {
  const { run, calls } = recordedRun(
    [
      { name: "hold_fare", result: { error: "upstream timeout after 8000 ms" } },
      { name: "hold_fare", result: { held: true } },
    ],
    ["hold_fare"],
  );
  const outcome = await replayRun(run, calls, failClearly("hold_fare"), deps());
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.after.calls, ["hold_fare", "hold_fare"]);
  assert.deepEqual(outcome.after.outcomes, ["error", "ok"]);
  assert.equal(endsWellOf(outcome.after), true);
});

test("a merged tool replaces its sources and is answered from their recorded results", async () => {
  const { run, calls } = recordedRun(
    [
      { name: "get_seat_map", result: { free: 47 } },
      { name: "select_seat", result: { seat: "32D" } },
    ],
    ["get_seat_map", "select_seat"],
  );
  const merge = change({
    collapse: ["get_seat_map", "select_seat"],
    replay: {
      tools: [
        {
          name: "seat_map_then_select",
          description: "Both in one call.",
          parameters: { type: "object", properties: {} },
          replaces: ["get_seat_map", "select_seat"],
        },
      ],
      failClearly: [],
      prerequisite: null,
      skill: null,
    },
  });
  const outcome = await replayRun(run, calls, merge, deps());
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.before.calls, ["get_seat_map", "select_seat"]);
  assert.deepEqual(outcome.after.calls, ["seat_map_then_select"]);
  assert.equal(outcome.facts.standIns.after, 0, "composed from the recording, not a stand-in");
  assert.equal(outcome.after.answered, true);
});

test("a call the recording can't answer goes to the tool stand-in, counted; the step cap stops a runaway side", async () => {
  const { run, calls } = recordedRun(
    [{ name: "hold_fare", result: { held: true } }],
    ["hold_fare"],
  );
  let n = 0;
  const looping: AgentModel = {
    model: "loop",
    standIn: true,
    async next() {
      n += 1;
      return {
        text: "",
        calls: [{ id: `x${n}`, name: "hold_fare", args: { ref: `R${n + 5}` } }],
        usage: { inputTokens: 10, outputTokens: 1 },
        latencyMs: 5,
        model: "loop",
      };
    },
  };
  // The side without the fix takes the recorded path (a baseline, RC-76); the side with it runs away.
  let sides = 0;
  const models: EvalModels = {
    ...standInModels(),
    agent: () => (sides++ === 0 ? scripted([[{ name: "hold_fare" }], []]) : looping),
  };
  const outcome = await replayRun(run, calls, failClearly("hold_fare"), deps(models, 5, 3));
  assert.ok(outcome.ok);
  assert.equal(outcome.after.calls!.length, 3);
  assert.equal(outcome.facts.standIns.after, 3);
  assert.equal(outcome.facts.capped, true);
  assert.equal(outcome.after.answered, false, "stopped at the cap: it never answered");
  assert.match(outcome.note ?? "", /tool results from a stand-in; stopped at the step cap/);
});

test("the replay says why it can't run: no prompts, no model, budget spent, nothing the fix changes", async () => {
  const { run, calls } = recordedRun(
    [{ name: "hold_fare", result: { held: true } }],
    ["hold_fare"],
  );
  const blank = calls.map((item) => ({ ...item, payload: null }));
  assert.deepEqual(await replayRun(run, blank, failClearly("hold_fare"), deps()), {
    ok: false,
    reason: CANT_SIMULATE.noPrompts,
  });
  assert.deepEqual(
    await replayRun(
      run,
      calls,
      failClearly("hold_fare"),
      deps({ agent: null, tool: null, judge: null, standIn: false }),
    ),
    { ok: false, reason: CANT_SIMULATE.noModel },
  );
  assert.deepEqual(
    await replayRun(run, calls, failClearly("hold_fare"), deps(standInModels(), 0)),
    { ok: false, reason: CANT_SIMULATE.budget },
  );
  const elsewhere = await replayRun(run, calls, failClearly("other_tool"), deps());
  assert.equal(elsewhere.ok, false);
  assert.equal(!elsewhere.ok && elsewhere.notAffected, true);
});

test("RC-69: a first call whose id the recorded conversation never shows can't be replayed, and says so before any model call", async () => {
  // Meridian's demo: "Can I get a window seat?" and the agent calls get_seat_map with a booking reference from nowhere.
  const { run, calls } = recordedRun(
    [
      {
        name: "hold_fare",
        result: { held: true },
        args: { booking_ref: "MRD4F2K9", date: "2026-12-12" },
      },
    ],
    ["hold_fare"],
  );
  const recording = readRecording(run, calls)!;
  assert.deepEqual(
    ungroundedArgs(recording),
    ["MRD4F2K9"],
    "a date isn't an id: the model works it out from words",
  );
  let asked = 0;
  const counting: EvalModels = {
    ...standInModels(),
    agent: (context) => ({
      ...scriptedAgent(context.recorded),
      next: async (input) => (asked++, scriptedAgent(context.recorded).next(input)),
    }),
  };
  assert.deepEqual(await replayRun(run, calls, failClearly("hold_fare"), deps(counting)), {
    ok: false,
    reason: CANT_SIMULATE.ungrounded,
  });
  assert.equal(asked, 0);
  // The run's own ask names R1: grounded.
  const grounded = recordedRun([{ name: "hold_fare", result: { held: true } }], ["hold_fare"]);
  assert.deepEqual(ungroundedArgs(readRecording(grounded.run, grounded.calls)!), []);
});

test("RC-69: a replay that makes no tool calls where the run made some is a failed replay, not a run that ended well", async () => {
  const { run, calls } = recordedRun(
    [{ name: "hold_fare", result: { held: true } }],
    ["hold_fare"],
  );
  let asked = 0;
  const asks: AgentModel = {
    model: "claude-sonnet-4-6",
    standIn: false,
    async next() {
      asked += 1;
      return {
        text: "Could you share your booking reference?",
        calls: [],
        usage: { inputTokens: 800, outputTokens: 20 },
        latencyMs: 5,
        model: "claude-sonnet-4-6",
      };
    },
  };
  const outcome = await replayRun(
    run,
    calls,
    failClearly("hold_fare"),
    deps({ ...standInModels(), agent: () => asks }),
  );
  assert.ok(!outcome.ok);
  assert.deepEqual(
    [outcome.reason, outcome.replayFailed, outcome.facts?.paths.before],
    [CANT_SIMULATE.noCalls, true, []],
  );
  assert.equal(asked, 1, "the side with the fix isn't paid for");
});

test("the dollar cap holds with 4 runs replayed at once: each call reserves its worst case first (review repro: $3.00 on a $1.00 cap)", async () => {
  // Four runs whose recorded calls each read 150k input tokens, replayed by an agent priced as claude-opus-5-5 ($0.60 a call).
  const runs = Array.from({ length: 4 }, () => {
    const recorded = recordedRun(
      [{ name: "hold_fare", result: FAIL }],
      ["hold_fare"],
      "claude-opus-5-5",
    );
    return {
      run: recorded.run,
      calls: recorded.calls.map((item) => ({ ...item, inputTokens: 150_000 })),
    };
  });
  let inFlight = 0;
  let peak = 0;
  let asked = 0;
  const opus: AgentModel = {
    model: "claude-opus-5-5",
    standIn: false,
    async next() {
      asked += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        text: "Sorry, that fare is gone.",
        calls: [],
        usage: { inputTokens: 150_000, outputTokens: 50 },
        latencyMs: 5,
        model: "claude-opus-5-5",
      };
    },
  };
  const spend = new SpendMeter(1);
  const shared = { ...deps({ ...standInModels(), agent: () => opus }), spend };
  const outcomes = await Promise.all(
    runs.map(({ run, calls }) => replayRun(run, calls, failClearly("hold_fare"), shared)),
  );

  assert.ok(spend.usd <= 1, `spent $${spend.usd.toFixed(2)} on a $1.00 cap`);
  assert.equal(asked, 1, "one $0.60 call fits; a second would pass the cap, so it is never made");
  assert.equal(peak, 1, "no lane called while another's worst case held the room");
  assert.equal(spend.reserved, 0, "every hold was settled or released");
  assert.equal(spend.exhausted, true);
  // The one lane that got its call answered without calling a tool where the run did (RC-69): a failed replay, not a fourth budget refusal.
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
    [CANT_SIMULATE.noCalls, CANT_SIMULATE.budget, CANT_SIMULATE.budget, CANT_SIMULATE.budget],
  );
});

test("a call waits for the calls in flight when its worst case doesn't fit yet, and goes once they settle under it", async () => {
  const meter = new SpendMeter(1);
  const first = await meter.reserve("claude-opus-5-5", {
    inputTokens: 90_000,
    outputTokens: 4_096,
  }); // $0.44 held
  assert.ok(first);
  const second = await meter.reserve("claude-opus-5-5", {
    inputTokens: 90_000,
    outputTokens: 4_096,
  }); // $0.88 held in all
  assert.ok(second);
  let third: Awaited<ReturnType<SpendMeter["reserve"]>> | undefined;
  const waiting = meter
    .reserve("claude-opus-5-5", { inputTokens: 90_000, outputTokens: 4_096 })
    .then((hold) => (third = hold));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(third, undefined, "no room yet: it waits");
  meter.settle(first, "claude-opus-5-5", { inputTokens: 10_000, outputTokens: 100 }); // really cost $0.042
  await waiting;
  assert.ok(third, "the room freed by the first call's real cost lets it go");
  meter.release(second);
  meter.release(third!);
  assert.equal(meter.reserved, 0);
  assert.equal(meter.calls, 1);
  assert.equal(
    await meter.reserve("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 }),
    null,
    "a call that can never fit is refused at once",
  );
});

test("a refused key stops the replay: the run says so, and the runs after it don't call the model", async () => {
  const { run, calls } = recordedRun([{ name: "hold_fare", result: FAIL }], ["hold_fare"]);
  let asked = 0;
  const refusing: AgentModel = {
    model: "claude-sonnet-4-6",
    standIn: false,
    async next() {
      asked += 1;
      throw new ModelRefused();
    },
  };
  const halt = { reason: null as string | null };
  const shared = { ...deps({ ...standInModels(), agent: () => refusing }), halt };
  assert.deepEqual(await replayRun(run, calls, failClearly("hold_fare"), shared), {
    ok: false,
    reason: CANT_SIMULATE.refused,
  });
  assert.deepEqual(await replayRun(run, calls, failClearly("hold_fare"), shared), {
    ok: false,
    reason: CANT_SIMULATE.refused,
  });
  assert.equal(asked, 1);
});

test("a skill goes into the system prompt and hands over its step tools", async () => {
  const { run, calls } = recordedRun(
    [{ name: "find_booking", result: { booking: "R1" } }],
    ["find_booking"],
  );
  const seen: { system?: string; tools: string[] }[] = [];
  const spy: AgentModel = {
    model: "spy",
    standIn: true,
    async next({ system, tools, messages }) {
      seen.push({ system, tools: tools.map((item) => item.name) });
      // Calls the recorded tool once per side, then answers: a replay that makes no calls fails (RC-69).
      const calls =
        messages.at(-1)?.role === "tool"
          ? []
          : [{ id: `c${seen.length}`, name: "find_booking", args: { ref: "R1" } }];
      return {
        text: "ok",
        calls,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        model: "spy",
      };
    },
  };
  const skill = change({
    skillSteps: ["find_booking", "check_in"],
    replay: {
      tools: [],
      failClearly: [],
      prerequisite: null,
      skill: { name: "Check in online", steps: ["find_booking", "check_in"] },
    },
  });
  const outcome = await replayRun(run, calls, skill, {
    ...deps({ ...standInModels(), agent: () => spy }),
    toolDefs: new Map([["check_in", tool("check_in")]]),
  });
  assert.ok(outcome.ok);
  // Two steps a side: without the fix, then with it.
  assert.deepEqual(seen[0]!.tools, ["find_booking"]);
  assert.deepEqual(seen[2]!.tools, ["find_booking", "check_in"]);
  assert.match(seen[2]!.system ?? "", /Skill "Check in online": .*find_booking, then check_in/);
});

/* - RC-76: what the replay did, and when it is a baseline -------------------- */

/** An agent that plays a fixed script of replies, one per step (an empty list answers). */
function scripted(
  steps: { name: string; args?: Record<string, unknown> }[][],
  model = "claude-sonnet-4-6",
): AgentModel {
  let n = 0;
  return {
    model,
    standIn: false,
    async next() {
      const calls = (steps[n] ?? []).map((step, i) => ({
        id: `s${n}_${i}`,
        name: step.name,
        args: step.args ?? { ref: "R1" },
      }));
      n += 1;
      return {
        text: calls.length === 0 ? "Done." : "",
        calls,
        usage: { inputTokens: 100, outputTokens: 10 },
        latencyMs: 5,
        model,
      };
    },
  };
}

/** Each side gets its own script: the first agent asked for is the side without the fix. */
function twoSides(
  before: Parameters<typeof scripted>[0],
  after: Parameters<typeof scripted>[0],
): EvalModels {
  let sides = 0;
  return {
    ...standInModels(),
    standIn: false,
    agent: () => scripted(sides++ === 0 ? before : after),
  };
}

const SEAT_MERGE = change({
  collapse: ["get_seat_map", "select_seat"],
  replay: {
    tools: [
      {
        name: "seat_map_then_select",
        description: "Both in one call.",
        parameters: { type: "object", properties: {} },
        replaces: ["get_seat_map", "select_seat"],
      },
    ],
    failClearly: [],
    prerequisite: null,
    skill: null,
  },
});

function seatRun() {
  return recordedRun(
    [
      { name: "get_seat_map", result: { free: ["23A"] }, args: { ref: "R1", flight: "F1" } },
      { name: "select_seat", result: { seat: "23A" }, args: { ref: "R1", seat: "23A" } },
    ],
    ["get_seat_map", "select_seat"],
  );
}

test("RC-76: the facts keep each side's path, how it stopped, and the recorded path as the fix would run it", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(run, calls, SEAT_MERGE, deps());
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.facts.paths, {
    recorded: ["get_seat_map", "select_seat"],
    before: ["get_seat_map", "select_seat"],
    after: ["seat_map_then_select"],
    intended: ["seat_map_then_select"],
  });
  assert.deepEqual(outcome.facts.stops, { before: "answered", after: "answered" });
});

test("RC-76: a side that doesn't take the recorded path is no baseline: the run isn't scored, the fix side isn't paid for, and the paths are kept", async () => {
  const { run, calls } = seatRun();
  let afterAsked = 0;
  let sides = 0;
  const models: EvalModels = {
    ...standInModels(),
    standIn: false,
    agent: () => {
      if (sides++ === 0)
        return scripted([[{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }], []]);
      return {
        ...scripted([]),
        next: async () => (
          afterAsked++,
          {
            text: "",
            calls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
            model: "m",
          }
        ),
      };
    },
  };
  const outcome = await replayRun(run, calls, SEAT_MERGE, deps(models));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, CANT_SIMULATE.drifted);
  assert.equal(outcome.replayFailed, true);
  assert.equal(afterAsked, 0);
  assert.deepEqual(outcome.facts?.paths, {
    recorded: ["get_seat_map", "select_seat"],
    before: ["get_seat_map"],
    after: [],
    intended: ["seat_map_then_select"],
  });
  assert.deepEqual(outcome.facts?.stops, { before: "answered", after: "not-run" });
  assert.equal(outcome.facts?.controlMatchesRecording, false);
});

test("RC-76: a replay with no tool calls keeps its (empty) path too", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(run, calls, SEAT_MERGE, deps(twoSides([[]], [[]])));
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, CANT_SIMULATE.noCalls);
  assert.deepEqual(outcome.facts?.paths.before, []);
  assert.deepEqual(outcome.facts?.stops, { before: "answered", after: "not-run" });
});

test("RC-76: a side stopped at the step cap says so", async () => {
  const { run, calls } = recordedRun(
    [{ name: "hold_fare", result: { held: true } }],
    ["hold_fare"],
  );
  const loop = Array.from({ length: 5 }, () => [{ name: "hold_fare" }]);
  const outcome = await replayRun(
    run,
    calls,
    failClearly("hold_fare"),
    deps(twoSides([[{ name: "hold_fare" }], []], loop), 5, 3),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.facts.stops, { before: "answered", after: "step-cap" });
});

test("RC-76: a call the conversation already answered before the run is a re-read: answered from there, and not a different path", async () => {
  // The booking was found in an earlier turn; the replay looks it up again before the seat map.
  const { run, calls } = seatRun();
  for (const item of calls) {
    const messages = item.payload!.messages;
    item.payload = {
      ...item.payload!,
      messages: [
        { role: "user", content: [{ type: "text", text: "Find booking R1" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "old_1", name: "find_booking", arguments: { ref: "R1" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "old_1",
          content: JSON.stringify({ booking: "R1", flight: "F1" }),
        },
        { role: "assistant", content: [{ type: "text", text: "Found it." }] },
        ...messages,
      ],
    };
  }
  const before = [
    [{ name: "find_booking" }],
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(before, [
        [{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1", seat: "23A" } }],
        [],
      ]),
    ),
  );
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(outcome.facts.paths.before, ["find_booking", "get_seat_map", "select_seat"]);
  assert.equal(outcome.facts.controlMatchesRecording, true);
  assert.equal(outcome.facts.standIns.before, 0, "the earlier result answers it");
});

test("RC-76: a merged call is answered from the recording only when it asks for what the recording did", async () => {
  const { run, calls } = seatRun();
  const before = [
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const same = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(before, [
        [{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1", seat: "23A" } }],
        [],
      ]),
    ),
  );
  assert.ok(same.ok);
  assert.equal(same.facts.standIns.after, 0);
  // A seat the map never offered: the recording can't say what the tool would have returned.
  const guessed = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(before, [
        [{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1", seat: "window" } }],
        [],
      ]),
    ),
  );
  assert.ok(guessed.ok);
  assert.equal(guessed.facts.standIns.after, 1);
});

test("RC-76: a merge's replay sides are held to doing what the run did: stopping early to ask is not fewer calls for free", async () => {
  const { run, calls } = seatRun();
  const before = [
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const expected = { ...NO_EXPECTATION, maxToolCalls: 1, endsWell: true };
  const score = async (after: Parameters<typeof scripted>[0]) => {
    const outcome = await replayRun(run, calls, SEAT_MERGE, deps(twoSides(before, after)));
    assert.ok(outcome.ok);
    const scored = scoreCase(
      { id: "c1", turnId: "t1", expected },
      { before: outcome.before, after: outcome.after, skipped: null, reranked: false },
      SEAT_MERGE,
    );
    return Object.fromEntries(scored.after!.checks.map((check) => [check.kind, check.pass]));
  };
  // Asked the traveler instead of booking the seat: one call, ends well, but the seat was never taken.
  assert.deepEqual(
    await score([[{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1" } }], []]),
    { max_tool_calls: true, ends_well: true, does_the_work: true },
  );
  assert.deepEqual(await score([[]]), {
    max_tool_calls: true,
    ends_well: true,
    does_the_work: false,
  });
});

test("RC-76: a call that passes every recorded argument unchanged, plus optional ones the run left out, gets the recorded result", async () => {
  // The model adds the traveler's last name to a lookup by reference: the same lookup.
  const { run, calls } = recordedRun(
    [{ name: "find_booking", result: { booking: "R1" }, args: { booking_ref: "R1" } }],
    ["find_booking"],
  );
  const before = [[{ name: "find_booking", args: { booking_ref: "R1", last_name: "Meijer" } }], []];
  const outcome = await replayRun(
    run,
    calls,
    failClearly("find_booking"),
    deps(twoSides(before, before)),
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.facts.standIns.before, 0);
  // Another reference is another lookup.
  const other = await replayRun(
    run,
    calls,
    failClearly("find_booking"),
    deps(twoSides([[{ name: "find_booking", args: { booking_ref: "R2" } }], []], [[]])),
  );
  assert.ok(other.ok);
  assert.equal(other.facts.standIns.before, 1);
});

test("RC-76: a side that doesn't do the run's work earns nothing for doing less: it fails and scores 0", async () => {
  const { run, calls } = seatRun();
  const before = [
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const outcome = await replayRun(run, calls, SEAT_MERGE, deps(twoSides(before, [[]])));
  assert.ok(outcome.ok);
  const expected = { ...NO_EXPECTATION, maxToolCalls: 1, endsWell: true };
  const scored = scoreCase(
    { id: "c1", turnId: "t1", expected },
    { before: outcome.before, after: outcome.after, skipped: null, reranked: false },
    SEAT_MERGE,
  );
  assert.equal(scored.after!.pass, false);
  assert.equal(
    scored.after!.score,
    0,
    "fewer calls and a quick answer are no credit when the seat was never taken",
  );
  assert.ok(scored.before!.score > 0);
});

test("RC-76: a value in other words is the same value; an id, a date or a number is not", () => {
  assert.ok(
    answers(
      { name: "search_car_rentals", args: { location: "Tokyo", pick_up: "2026-11-19" } },
      { name: "search_car_rentals", args: { location: "Tokyo (HND)", pick_up: "2026-11-19" } },
    ),
  );
  assert.ok(
    !answers(
      { name: "search_car_rentals", args: { location: "Tokyo", pick_up: "2026-11-19" } },
      { name: "search_car_rentals", args: { location: "Tokyo", pick_up: "2026-11-20" } },
    ),
  );
  assert.ok(
    !answers(
      { name: "select_seat", args: { seat: "23A" } },
      { name: "select_seat", args: { seat: "window" } },
    ),
  );
  assert.ok(
    !answers({ name: "pick", args: { kind: "window" } }, { name: "pick", args: { kind: "aisle" } }),
  );
});

test("RC-76: work done through a merged call the recording couldn't answer isn't vouched for: a guessed seat doesn't do the run's work", async () => {
  const { run, calls } = seatRun();
  const before = [
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(before, [
        [{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1", seat: "window" } }],
        [],
      ]),
    ),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.facts.paths.after, ["seat_map_then_select"]);
  assert.equal(outcome.after.coversRecording, false);
  const scored = scoreCase(
    { id: "c1", turnId: "t1", expected: { ...NO_EXPECTATION, maxToolCalls: 1 } },
    { before: outcome.before, after: outcome.after, skipped: null, reranked: false },
    SEAT_MERGE,
  );
  const work = scored.after!.checks.find((check) => check.kind === "does_the_work")!;
  assert.equal(work.pass, false);
  assert.match(work.detail, /can't vouch/);
});

test("RC-76: a merge whose merged call only a stand-in answered fails on the verdict and on every per-scorer column", async () => {
  const { run, calls } = seatRun();
  const before = [
    [{ name: "get_seat_map", args: { ref: "R1", flight: "F1" } }],
    [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
    [],
  ];
  const models: EvalModels = {
    ...twoSides(before, [
      [{ name: "seat_map_then_select", args: { ref: "R1", flight: "F1", seat: "window" } }],
      [],
    ]),
    judge: {
      model: "claude-haiku-4-5",
      standIn: false,
      judge: async () => ({ pass: true, usage: { inputTokens: 10, outputTokens: 1 } }),
    },
  };
  const scorers: Scorer[] = [
    { kind: "ends_well" },
    { kind: "max_tool_calls", max: 2 },
    { kind: "judge_criteria", criteria: "Takes a seat." },
    { kind: "max_cost_usd", max: 1 },
  ];
  const item: SimulationCase = {
    id: "c1",
    turnId: "t1",
    traceId: null,
    origin: "task",
    originRef: null,
    position: 0,
    outcome: "",
    criteria: "",
    role: "holdout",
    expected: { ...NO_EXPECTATION, endsWell: true, maxToolCalls: 2, maxCostUsd: 1 },
    run,
    calls,
    scorers,
  };
  const sim = await simulateCases([item], { ...SEAT_MERGE, kind: "merge" }, models, {
    dailyLeftUsd: 5,
  });
  const result = sim.results[0]!;
  assert.equal(result.simulated, true);
  assert.equal(result.before!.pass, true);
  assert.equal(result.after!.pass, false);
  assert.equal(result.after!.score, 0);
  const columns = sim.scorerResults![0]!;
  assert.deepEqual(
    columns.before.map((column) => column.status),
    ["pass", "pass", "pass", "pass"],
  );
  assert.deepEqual(
    columns.after.map((column) => column.status),
    ["fail", "fail", "fail", "fail"],
  );
});

test("RC-76: a task's drafted cost and time limits are rebased on the replay's baseline for the verdict and the per-scorer columns alike", async () => {
  const { run, calls } = recordedRun(
    [{ name: "find_booking", result: { booking: "R1" } }],
    ["find_booking"],
  );
  const steps = [[{ name: "find_booking" }], []];
  // Drafted from live runs (source "default"): far below what a replay costs. A limit a person set stays as set.
  const drafted = [
    { kind: "max_cost_usd" as const, max: 0.000_01, source: "default" },
    { kind: "max_latency_ms" as const, max: 1, source: "user" },
  ];
  const item: SimulationCase = {
    id: "c1",
    turnId: "t1",
    traceId: null,
    origin: "task",
    originRef: null,
    position: 0,
    outcome: "",
    criteria: "",
    role: "holdout",
    expected: { ...NO_EXPECTATION, maxCostUsd: 0.000_01, maxLatencyMs: 1 },
    run,
    calls,
    scorers: drafted,
  };
  const sim = await simulateCases(
    [item],
    { ...failClearly("find_booking"), kind: "fail-clearly" },
    twoSides(steps, steps),
    { dailyLeftUsd: 5 },
  );
  const result = sim.results[0]!;
  const verdict = (side: CaseResult["before"]) =>
    Object.fromEntries(side!.checks.map((check) => [check.kind, check.pass]));
  assert.deepEqual(verdict(result.before), { max_cost: true, max_latency: false });
  const columns = sim.scorerResults![0]!;
  assert.deepEqual(
    columns.before.map((column) => [column.kind, column.status]),
    [
      ["max_cost_usd", "pass"],
      ["max_latency_ms", "fail"],
    ],
  );
  assert.deepEqual(
    columns.after.map((column) => [column.kind, column.status === "pass"]),
    [
      ["max_cost_usd", verdict(result.after).max_cost],
      ["max_latency_ms", verdict(result.after).max_latency],
    ],
  );
});

/* - which method, and what a fix gives the replay ---------------------------- */

test("a drafted merge gives the replay its crafted definition and the tools it stands in for", () => {
  const base =
    buildFixes(fixesInput()).open.find((item) => item.source === "craft") ??
    buildFixes(fixesInput()).open[0]!;
  const json = JSON.stringify({
    name: "a_then_b",
    description: "Does a, then b.",
    searchableDescription: "a and b",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    dispatch: [{ sourceToolId: "a" }, { sourceToolId: "b" }],
  });
  const fix = {
    ...base,
    kind: "merge" as const,
    subject: {
      ...base.subject,
      tools: [
        { id: "a", label: "a", href: "" },
        { id: "b", label: "b", href: "" },
      ],
    },
    detail: {
      source: "craft" as const,
      craftKind: "merge_tools" as const,
      plain: "",
      why: [],
      worth: [],
      worthCaption: null,
      replay: null,
      change: [],
      facts: [],
      sources: [
        { id: "a", name: "a", description: "" },
        { id: "b", name: "b", description: "" },
      ],
      crafted: [{ name: "a_then_b", json, typescript: "", python: "" }],
    },
  };
  const result = changeOf(fix);
  assert.deepEqual(result.replay?.tools, [
    {
      name: "a_then_b",
      description: "Does a, then b.",
      parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      replaces: ["a", "b"],
    },
  ]);
  const prerequisite = changeOf({ ...fix, kind: "prerequisite" });
  assert.deepEqual(prerequisite.replay?.tools[0]?.replaces, ["b"]);
  assert.deepEqual(prerequisite.replay?.prerequisite, { before: "a", tool: "b" });
});

/* - the Messages API shape and the stand-in -------------------------------------- */

test("the replay's conversation as Messages API turns", () => {
  const messages = toApiMessages([
    { role: "assistant", text: "orphan", calls: [] },
    { role: "user", text: "Hold my fare" },
    {
      role: "assistant",
      text: "",
      calls: [{ id: "toolu_1", name: "hold_fare", args: { ref: "R1" } }],
    },
    { role: "tool", callId: "toolu_1", content: '{"error":"x"}', isError: true },
    { role: "user", text: "and?" },
  ]);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  const results = messages[2]!.content as { type: string; is_error?: boolean }[];
  assert.deepEqual(
    results.map((block) => block.type),
    ["tool_result", "text"],
  );
  assert.equal(results[0]!.is_error, true);
});

test("the scripted stand-in replays the recording in order and skips tools it isn't offered", async () => {
  const agent = scriptedAgent([
    { id: "1", name: "a", args: {} },
    { id: "2", name: "gone", args: {} },
    { id: "3", name: "b", args: {} },
  ]);
  const tools = [tool("a"), tool("b")];
  const first = await agent.next({ system: undefined, tools, messages: [] });
  const second = await agent.next({ system: undefined, tools, messages: [] });
  const third = await agent.next({ system: undefined, tools, messages: [] });
  assert.deepEqual(
    [first.calls[0]?.name, second.calls[0]?.name, third.calls.length],
    ["a", "b", 0],
  );
});
