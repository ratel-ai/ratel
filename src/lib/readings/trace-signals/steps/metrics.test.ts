import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepDraft, StepKind } from "@/lib/ledger/types";
import { detectAfterErrors } from "../self-corrections/detect";
import { analyzeTurns } from "../signals/analyze";
import { addOtelDays, otelDayOf } from "../signals/otel-day";
import { call, otelWorld, trace } from "../signals/otel-test-fixtures";
import { quantile } from "../signals/severity";
import { contextFor } from "../signals/test-fixtures";
import type { SignalTurn } from "../signals/types";
import { type ModelCallFact, type SegmentFact, stepReadingsOf } from "./metrics";

const T0 = Date.UTC(2026, 10, 20, 12);
let ids = 0;

interface StepSpec {
  kind: StepKind;
  name?: string;
  error?: boolean;
  tookMs?: number;
  targetType?: "tool" | "skill";
  at?: number;
}

function step(spec: StepSpec, ordinal: number, start: number): StepDraft {
  const occurredAt = new Date(start + (spec.at ?? ordinal * 1000));
  return {
    ordinal,
    kind: spec.kind,
    eventType:
      spec.kind === "invoke"
        ? spec.error
          ? "invoke_error"
          : "invoke_end"
        : spec.kind === "model_call"
          ? "otlp_model_call"
          : "otlp_step",
    traceEventId: `ev-${++ids}`,
    endTraceEventId: null,
    declared: false,
    occurredAt,
    receivedAt: occurredAt,
    endOccurredAt: null,
    endReceivedAt: null,
    gapMs: null,
    searchOrdinal: null,
    searchType: null,
    queryHash: spec.kind === "user_message" ? `msg-${ids}` : null,
    topK: null,
    hitCount: null,
    hitIds: null,
    hitScores: null,
    targetType: spec.kind === "invoke" ? (spec.targetType ?? "tool") : null,
    targetId: spec.kind === "user_message" ? null : (spec.name ?? spec.kind),
    invocationId: null,
    outcome: spec.kind === "user_message" ? null : spec.error ? "error" : "ok",
    tookMs: spec.kind === "user_message" ? null : (spec.tookMs ?? 100),
    offeredByOrdinal: null,
    offeredSearchOrdinal: null,
    offeredRank: null,
    firstSearchRank: null,
  };
}

function run(
  specs: readonly StepSpec[],
  opts: { id?: string; durationMs?: number; start?: number } = {},
): SignalTurn {
  const start = opts.start ?? T0;
  return {
    id: opts.id ?? `turn-${++ids}`,
    sessionId: `session-${ids}`,
    turnSource: "otlp",
    lane: "otlp",
    startedAt: new Date(start),
    endedAt: new Date(start + (opts.durationMs ?? 10_000)),
    searchCount: 0,
    invokeCount: specs.filter((s) => s.kind === "invoke").length,
    errorCount: specs.filter((s) => s.error).length,
    reSearchCount: 0,
    abandoned: null,
    detour: false,
    firstTry: null,
    steps: specs.map((spec, i) => step(spec, i + 1, start)),
  };
}

const model = (name = "claude", opts: Omit<StepSpec, "kind" | "name"> = {}): StepSpec => ({
  kind: "model_call",
  name,
  ...opts,
});

test("model calls read calls per run, errors, latency, tokens, cost, finish reasons and retries", () => {
  const turns = [
    run([
      { kind: "user_message" },
      model("claude", { tookMs: 100 }),
      model("claude", { tookMs: 300, error: true }),
      model("claude", { tookMs: 200 }),
    ]),
    run([{ kind: "user_message" }, model("claude", { tookMs: 400 })]),
  ];
  const facts = new Map<string, ModelCallFact>();
  const modelSteps = turns.flatMap((t) => t.steps.filter((s) => s.kind === "model_call"));
  modelSteps.forEach((s, i) =>
    facts.set(s.traceEventId, {
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: i === 0 ? 5 : null,
      costUsd: i < 2 ? 0.25 : null,
      finishReason: i === 1 ? "length" : i === 3 ? "content_filter" : "stop",
    }),
  );

  const reading = stepReadingsOf(turns, { modelCalls: facts }).kinds.model_call;

  assert.ok(reading);
  assert.equal(reading.calls, 4);
  assert.equal(reading.runs, 2);
  assert.equal(reading.callsPerRun, 2);
  assert.equal(reading.errors, 1);
  assert.equal(reading.errorRate, 0.25);
  assert.equal(reading.p50Ms, 200);
  assert.equal(reading.p95Ms, 400);
  assert.equal(reading.inputTokens, 400);
  assert.equal(reading.outputTokens, 40);
  assert.equal(reading.reasoningTokens, 5);
  assert.equal(reading.costUsd, 0.5);
  assert.equal(reading.pricedCalls, 2);
  assert.deepEqual(reading.finish, { length: 1, contentFilter: 1, known: 4 });
  assert.equal(reading.retries, 1);
});

test("model calls without facts read no tokens and no cost", () => {
  const reading = stepReadingsOf([run([model()])]).kinds.model_call;
  assert.ok(reading);
  assert.equal(reading.inputTokens, 0);
  assert.equal(reading.costUsd, null);
  assert.deepEqual(reading.finish, { length: 0, contentFilter: 0, known: 0 });
});

test("a kind with no steps reads null", () => {
  const readings = stepReadingsOf([run([model()])]);
  assert.equal(readings.kinds.code, null);
  assert.equal(readings.kinds.tool_call, null);
  assert.equal(readings.runs, 1);
});

test("tool calls equal today's tool numbers on tool fixtures", () => {
  const world = otelWorld([
    ...Array.from({ length: 6 }, () =>
      trace([call("search", { tookMs: 120 }), call("fetch", { tookMs: 300 })]),
    ),
    ...Array.from({ length: 3 }, () =>
      trace([call("search", { error: "timeout", tookMs: 900 }), call("search", { tookMs: 80 })]),
    ),
    ...Array.from({ length: 2 }, () =>
      trace([call("fetch", { error: "denied", tookMs: 50 }), call("lookup", { tookMs: 60 })]),
    ),
    trace([call("lookup", { tookMs: 70 }), call("fetch", { error: "denied", tookMs: 40 })]),
  ]);
  const today = world.turns.map((t) => otelDayOf(t)).reduce((sum, day) => addOtelDays(sum, day)!);
  const events = world.turns.flatMap((t) => detectAfterErrors(t.steps));
  const latency = world.turns.flatMap((t) =>
    t.steps.filter((s) => s.kind === "invoke").map((s) => s.tookMs!),
  );

  const reading = stepReadingsOf(world.turns).kinds.tool_call;

  assert.ok(reading);
  assert.equal(reading.calls, today.calls);
  assert.equal(reading.errors, today.failedCalls);
  assert.equal(reading.errorRate, today.failedCalls / today.calls);
  assert.equal(reading.p95Ms, quantile(latency, 0.95));
  assert.equal(reading.retries, events.filter((e) => e.kind === "retry_after_error").length);
  assert.equal(reading.switches, events.filter((e) => e.kind === "switch_after_error").length);
  assert.equal(reading.giveUps, events.filter((e) => e.kind === "gave_up_after_error").length);
  assert.equal(reading.retries, 3);
  assert.equal(reading.switches, 2);
  assert.equal(reading.giveUps, 1);
  assert.equal(stepReadingsOf(world.turns).kinds.skill, null);
});

test("skills read apart from tools, with their own after-error counts", () => {
  const turns = [
    run([
      { kind: "invoke", name: "lookup" },
      { kind: "invoke", name: "brief", targetType: "skill", error: true },
      { kind: "invoke", name: "brief", targetType: "skill" },
    ]),
  ];
  const { tool_call, skill } = stepReadingsOf(turns).kinds;
  assert.equal(tool_call?.calls, 1);
  assert.equal(tool_call?.retries, 0);
  assert.equal(skill?.calls, 2);
  assert.equal(skill?.errors, 1);
  assert.equal(skill?.retries, 1);
});

test("code steps read calls, errors, p95 and their share of run time", () => {
  const turns = [
    run(
      [
        model(),
        { kind: "code", name: "prepare", tookMs: 2000 },
        { kind: "code", name: "render", tookMs: 1000, error: true },
      ],
      { durationMs: 10_000 },
    ),
    run([model(), { kind: "code", name: "prepare", tookMs: 3000 }], { durationMs: 10_000 }),
    run([model()], { durationMs: 50_000 }),
  ];
  const reading = stepReadingsOf(turns).kinds.code;
  assert.ok(reading);
  assert.equal(reading.calls, 3);
  assert.equal(reading.errors, 1);
  assert.equal(reading.errorRate, 1 / 3);
  assert.equal(reading.p95Ms, 3000);
  assert.equal(reading.runTimeShare, 6000 / 20_000);
});

test("handoffs read routes from the agent that handed off and the receiving run's errors", () => {
  const turns = [
    run([
      { kind: "agent", name: "growth" },
      model(),
      { kind: "handoff", name: "researcher" },
      { kind: "handoff", name: "writer", error: true },
    ]),
    run([
      { kind: "agent", name: "growth" },
      { kind: "handoff", name: "researcher" },
    ]),
    run([model(), { kind: "handoff", name: "researcher", error: true }]),
  ];
  const reading = stepReadingsOf(turns).kinds.handoff;
  assert.ok(reading);
  assert.equal(reading.count, 4);
  assert.equal(reading.errors, 2);
  assert.equal(reading.errorRate, 0.5);
  assert.deepEqual(reading.routes, [
    { from: "growth", to: "researcher", count: 2, errors: 0 },
    { from: null, to: "researcher", count: 1, errors: 1 },
    { from: "researcher", to: "writer", count: 1, errors: 1 },
  ]);
});

test("user messages read messages per segment, the sentiment mix and the asked-again share", () => {
  const a = run([{ kind: "user_message" }, model(), { kind: "user_message" }, model()], {
    id: "a",
  });
  const b = run([{ kind: "user_message" }, model()], { id: "b" });
  const c = run([{ kind: "user_message" }, model()], { id: "c" });
  const topics = new Map([
    ["a", { sentiment: "negative" as const, askedAgain: true }],
    ["b", { sentiment: "positive" as const, askedAgain: false }],
    ["c", { sentiment: null, askedAgain: false }],
  ]);
  const readings = stepReadingsOf(
    [a, b, c],
    {},
    {
      topics,
      segments: [
        segment("t", a, 1, 2),
        segment("t", a, 3, 4),
        segment("t", b, 1, 2),
        segment("t", c, 1, 2),
      ],
    },
  );
  const reading = readings.kinds.user_message;
  assert.ok(reading);
  assert.equal(reading.messages, 4);
  assert.equal(reading.segments, 4);
  assert.equal(reading.perSegment, 1);
  assert.deepEqual(reading.sentiment, { positive: 1, neutral: 0, negative: 1, read: 2 });
  assert.deepEqual(reading.askedAgain, { runs: 1, read: 3, share: 1 / 3 });
});

test("user messages without segments read per run", () => {
  const reading = stepReadingsOf([
    run([{ kind: "user_message" }, { kind: "user_message" }, model()]),
  ]).kinds.user_message;
  assert.equal(reading?.segments, 1);
  assert.equal(reading?.perSegment, 2);
  assert.equal(reading?.sentiment, null);
  assert.equal(reading?.askedAgain, null);
});

function segment(
  workflowId: string,
  turn: SignalTurn,
  startOrdinal: number,
  endOrdinal: number,
  over: Partial<SegmentFact> = {},
): SegmentFact {
  const steps = turn.steps.filter((s) => s.ordinal >= startOrdinal && s.ordinal <= endOrdinal);
  return {
    workflowId,
    startTurnId: turn.id,
    startOrdinal,
    endTurnId: turn.id,
    endOrdinal,
    startedAt: steps[0]!.occurredAt,
    endedAt: new Date(steps.at(-1)!.occurredAt.getTime() + (steps.at(-1)!.tookMs ?? 0)),
    turnIds: [turn.id],
    ...over,
  };
}

test("tasks read runs, finish rate, cost per run, duration, self-corrections and the weakest step from segments", () => {
  const a = run(
    [
      { kind: "user_message" },
      model("claude"),
      { kind: "invoke", name: "lookup", error: true },
      { kind: "invoke", name: "lookup" },
      { kind: "user_message" },
      model("claude"),
    ],
    { id: "a" },
  );
  const b = run(
    [{ kind: "user_message" }, model("claude"), { kind: "code", name: "render", error: true }],
    { id: "b" },
  );
  const c = run([{ kind: "user_message" }, model("claude", { error: true })], { id: "c" });
  const facts = new Map<string, ModelCallFact>(
    [a, b, c]
      .flatMap((t) => t.steps.filter((s) => s.kind === "model_call"))
      .map((s) => [
        s.traceEventId,
        {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: null,
          costUsd: 0.1,
          finishReason: null,
        },
      ]),
  );
  const segments = [
    segment("research", a, 1, 4, { startedAt: new Date(T0), endedAt: new Date(T0 + 4000) }),
    segment("research", b, 1, 3, { startedAt: new Date(T0), endedAt: new Date(T0 + 2000) }),
    segment("research", c, 1, 2, { startedAt: new Date(T0), endedAt: new Date(T0 + 6000) }),
    segment("reply", a, 5, 6),
  ];

  const tasks = stepReadingsOf([a, b, c], { modelCalls: facts }, { segments }).tasks;

  assert.equal(tasks.length, 2);
  const research = tasks[0]!;
  assert.equal(research.workflowId, "research");
  assert.equal(research.runs, 3);
  assert.equal(research.finished, 1);
  assert.equal(research.finishRate, 1 / 3);
  assert.ok(Math.abs(research.costPerRun! - 0.1) < 1e-9);
  assert.equal(research.p50DurationMs, 4000);
  assert.equal(research.selfCorrectionsPer100, 100);
  assert.deepEqual(research.weakestStep, {
    kind: "code",
    name: "render",
    calls: 1,
    errors: 1,
    errorRate: 1,
  });
  assert.equal(tasks[1]!.workflowId, "reply");
  assert.equal(tasks[1]!.weakestStep, null);
});

test("no segments read no tasks", () => {
  assert.deepEqual(stepReadingsOf([run([model()])]).tasks, []);
});

test("the signal run stores the per-kind readings and step calls only with typed steps on", () => {
  const turns = [
    run([{ kind: "user_message" }, model("claude", { error: true }), model("claude")]),
    run([model("claude")]),
  ];
  const facts = new Map([
    [
      turns[1]!.steps[0]!.traceEventId,
      {
        inputTokens: 7,
        outputTokens: 3,
        reasoningTokens: null,
        costUsd: 0.01,
        finishReason: "stop",
      },
    ],
  ]);
  const context = contextFor(turns, { modelCalls: facts });

  const off = analyzeTurns(turns, context);
  assert.equal(off.summary.steps, undefined);
  assert.equal(off.stepMetrics, undefined);
  assert.ok(off.summary.daily.every((day) => day.steps === undefined));

  const on = analyzeTurns(turns, context, { workflowMining: { typedSteps: true } });
  assert.equal(on.summary.steps?.kinds.model_call?.calls, 3);
  assert.equal(on.summary.steps?.kinds.model_call?.inputTokens, 7);
  assert.deepEqual(
    on.summary.daily.reduce((sum, day) => sum + (day.steps?.failed ?? 0), 0),
    1,
  );
  assert.deepEqual(on.stepMetrics?.finish(), on.summary.steps);
});
