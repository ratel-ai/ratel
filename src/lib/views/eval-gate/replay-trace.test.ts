import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "./calls";
import { emptyChange } from "./change";
import { type AgentModel, type EvalModels, SpendMeter, standInModels } from "./models";
import { type ReplayDeps, replayAsRecorded, replayRun } from "./replay";
import type { FixChange, RunRecord, ToolDef } from "./types";

/* - fixtures (a small copy of replay.test.ts's, so that file stays unchanged) - */

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "tool_call" as const,
  id,
  name,
  arguments: args,
});

function recordedRun(
  steps: { name: string; result: unknown; args: Record<string, unknown> }[],
  offered: string[],
  earlier: CloudMessage[] = [],
): { run: RunRecord; calls: ModelCall[] } {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: offered.map((name) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
  const conversation: CloudMessage[] = [
    ...earlier,
    { role: "user", content: [{ type: "text", text: "Pick seat 23A on R1" }] },
  ];
  const calls: ModelCall[] = [];
  steps.forEach((step, index) => {
    const output: CloudMessage = {
      role: "assistant",
      content: [call(`toolu_${index}`, step.name, step.args)],
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
    occurredAt: at(steps.length * 2),
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
      endedAt: at(steps.length * 2).toISOString(),
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

function scripted(steps: { name: string; args: Record<string, unknown> }[][]): AgentModel {
  let n = 0;
  return {
    model: "claude-sonnet-4-6",
    standIn: false,
    async next() {
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

function twoSides(
  before: Parameters<typeof scripted>[0],
  after: Parameters<typeof scripted>[0],
  over: Partial<EvalModels> = {},
): EvalModels {
  let sides = 0;
  return {
    ...standInModels(),
    standIn: false,
    agent: () => scripted(sides++ === 0 ? before : after),
    ...over,
  };
}

function deps(models: EvalModels, trace?: ReplayDeps["trace"]): ReplayDeps {
  return {
    models,
    spend: new SpendMeter(5),
    maxSteps: 8,
    toolDefs: new Map<string, ToolDef>(),
    ...(trace ? { trace } : {}),
  };
}

const MAP = { ref: "R1", flight: "F1" };
const SELECT = { ref: "R1", seat: "23A" };
const seatRun = (earlier: CloudMessage[] = []) =>
  recordedRun(
    [
      { name: "get_seat_map", result: { free: ["23A"] }, args: MAP },
      { name: "select_seat", result: { seat: "23A" }, args: SELECT },
    ],
    ["get_seat_map", "select_seat"],
    earlier,
  );
const change = (over: Partial<FixChange>): FixChange => ({ ...emptyChange(), ...over });
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
const RECORDED_PATH = [
  [{ name: "get_seat_map", args: MAP }],
  [{ name: "select_seat", args: SELECT }],
  [],
];

/* - tests ------------------------------------------------------------------- */

test("recorded and composed answers say their source and reason, with args and results when text is kept", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(RECORDED_PATH, [
        [{ name: "seat_map_then_select", args: { ...MAP, seat: "23A" } }],
        [],
      ]),
      { keepText: true },
    ),
  );
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(
    outcome.trace!.before.answers.map(({ tool, source, reason }) => ({ tool, source, reason })),
    [
      { tool: "get_seat_map", source: "recorded", reason: "matched_recording" },
      { tool: "select_seat", source: "recorded", reason: "matched_recording" },
    ],
  );
  const [composed] = outcome.trace!.after!.answers;
  assert.equal(composed!.source, "composed");
  assert.equal(composed!.reason, "merged_from_sources");
  assert.deepEqual(composed!.args, { ...MAP, seat: "23A" });
  assert.deepEqual(JSON.parse(composed!.result!), {
    get_seat_map: { free: ["23A"] },
    select_seat: { seat: "23A" },
  });
  assert.equal(typeof composed!.ms, "number");
  assert.deepEqual(outcome.trace!.before.toolsOffered, ["get_seat_map", "select_seat"]);
  const steps = outcome.trace!.before.transcript!;
  assert.deepEqual(
    steps.map((step) => step.role),
    ["assistant", "tool", "assistant", "tool", "assistant"],
  );
  const last = steps.at(-1)!;
  assert.equal(last.role === "assistant" ? last.text : null, "Seat 23A is yours.");
});

test("a re-read of a call answered before the run says it came from earlier", async () => {
  const { run, calls } = seatRun([
    { role: "user", content: [{ type: "text", text: "Find booking R1" }] },
    { role: "assistant", content: [call("old_1", "find_booking", { ref: "R1" })] },
    { role: "tool", tool_call_id: "old_1", content: JSON.stringify({ booking: "R1" }) },
    { role: "assistant", content: [{ type: "text", text: "Found it." }] },
  ]);
  const before = [[{ name: "find_booking", args: { ref: "R1" } }], ...RECORDED_PATH];
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(before, [[{ name: "seat_map_then_select", args: { ...MAP, seat: "23A" } }], []]),
      { keepText: false },
    ),
  );
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(outcome.trace!.before.answers[0], {
    tool: "find_booking",
    source: "earlier",
    reason: "answered_before_run",
    ms: outcome.trace!.before.answers[0]!.ms,
  });
});

test("a call the recording can't answer goes to the stand-in, or says no stand-in was there", async () => {
  const { run, calls } = seatRun();
  const unknownAfter = [[{ name: "seat_map_then_select", args: { ref: "R9", seat: "1A" } }], []];
  const withStandIn = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(twoSides(RECORDED_PATH, unknownAfter), { keepText: false }),
  );
  assert.ok(withStandIn.ok, withStandIn.ok ? "" : withStandIn.reason);
  assert.deepEqual(
    withStandIn.trace!.after!.answers.map(({ source, reason }) => ({ source, reason })),
    [{ source: "stand-in", reason: "stand_in_model" }],
  );
  const noStandIn = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(twoSides(RECORDED_PATH, unknownAfter, { tool: null }), { keepText: false }),
  );
  assert.ok(noStandIn.ok, noStandIn.ok ? "" : noStandIn.reason);
  assert.deepEqual(
    noStandIn.trace!.after!.answers.map(({ source, reason }) => ({ source, reason })),
    [{ source: "stand-in", reason: "no_stand_in" }],
  );
});

test("keepText false keeps sources and reasons but no text", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(RECORDED_PATH, [
        [{ name: "seat_map_then_select", args: { ...MAP, seat: "23A" } }],
        [],
      ]),
      { keepText: false },
    ),
  );
  assert.ok(outcome.ok);
  for (const side of [outcome.trace!.before, outcome.trace!.after!]) {
    assert.equal("transcript" in side, false);
    for (const answer of side.answers)
      assert.deepEqual(Object.keys(answer).sort(), ["ms", "reason", "source", "tool"]);
  }
});

test("without the trace option the outcome is exactly today's: no trace key", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(
      twoSides(RECORDED_PATH, [
        [{ name: "seat_map_then_select", args: { ...MAP, seat: "23A" } }],
        [],
      ]),
    ),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(Object.keys(outcome).sort(), ["after", "before", "facts", "note", "ok"]);
});

test("a failed baseline still returns the side it ran, so the reader sees why", async () => {
  const { run, calls } = seatRun();
  const outcome = await replayRun(
    run,
    calls,
    SEAT_MERGE,
    deps(twoSides([[{ name: "select_seat", args: SELECT }], []], []), { keepText: false }),
  );
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.replayFailed);
  assert.deepEqual(!outcome.ok && outcome.trace?.before.answers.map((answer) => answer.source), [
    "recorded",
  ]);
  assert.equal(!outcome.ok && outcome.trace?.after, null);
});

test("RC-289: a replay as recorded runs one side with no fix and keeps a different path as a result", async () => {
  const { run, calls } = seatRun();
  const same = await replayAsRecorded(
    run,
    calls,
    deps(twoSides(RECORDED_PATH, []), { keepText: false }),
  );
  assert.ok(same.ok, same.ok ? "" : same.reason);
  assert.deepEqual(same.view.calls, ["get_seat_map", "select_seat"]);
  assert.equal(same.view.answered, true);
  assert.deepEqual(
    same.trace!.answers.map((answer) => answer.source),
    ["recorded", "recorded"],
  );
  const other = await replayAsRecorded(
    run,
    calls,
    deps(twoSides([[{ name: "select_seat", args: SELECT }], []], [])),
  );
  assert.ok(other.ok);
  assert.deepEqual(other.view.calls, ["select_seat"]);
  assert.equal("trace" in other, false);
  const blank = await replayAsRecorded(
    run,
    calls.map((item) => ({ ...item, payload: null })),
    deps(twoSides([], [])),
  );
  assert.equal(blank.ok, false);
});
