import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "./format";
import { buildRunMetrics, isRoutineHook, type RunMetricsSpan, spanWait } from "./run-metrics";

const T0 = Date.parse("2026-11-17T10:00:00.000Z");

function span(
  overrides: Partial<RunMetricsSpan> & { spanId: string; offsetMs?: number },
): RunMetricsSpan {
  const { offsetMs = 0, ...rest } = overrides;
  return {
    parentSpanId: "root",
    name: "step",
    spanClass: "other",
    startedAt: new Date(T0 + offsetMs).toISOString(),
    durationMs: 0,
    statusCode: 1,
    inputTokens: null,
    cachedTokens: null,
    attributes: {},
    events: null,
    ...rest,
  };
}

const root = (attributes: Record<string, unknown> = {}, extra: Partial<RunMetricsSpan> = {}) =>
  span({
    spanId: "root",
    parentSpanId: null,
    name: "invoke_agent claude",
    durationMs: 100_000,
    attributes: { "gen_ai.agent.name": "claude", ...attributes },
    ...extra,
  });
const chat = (
  spanId: string,
  offsetMs: number,
  durationMs: number,
  extra: Partial<RunMetricsSpan> = {},
) =>
  span({
    spanId,
    offsetMs,
    durationMs,
    spanClass: "llm_call",
    name: "chat claude-opus-5-5",
    attributes: { "gen_ai.agent.name": "claude" },
    ...extra,
  });
const tool = (
  spanId: string,
  offsetMs: number,
  durationMs: number,
  attributes: Record<string, unknown> = {},
) =>
  span({
    spanId,
    offsetMs,
    durationMs,
    spanClass: "tool",
    name: "execute_tool Bash:git",
    attributes,
  });

test("splits a run's time between the model, a person and the tools", () => {
  const metrics = buildRunMetrics([
    root({ "ratel.run.human_wait_ms": 30_000 }),
    chat("c1", 0, 20_000),
    tool("t1", 20_000, 40_000, {
      "ratel.wait.human_ms": 30_000,
      "ratel.wait.kind": "permission",
      "ratel.wait.outcome": "approved",
    }),
    chat("c2", 60_000, 10_000),
  ]);
  assert.deepEqual(metrics.timeSplit, {
    totalMs: 100_000,
    modelMs: 30_000,
    humanWaitMs: 30_000,
    toolMs: 40_000,
  });
});

test("model calls that run at the same time count once", () => {
  const metrics = buildRunMetrics([
    root(),
    chat("c1", 0, 20_000),
    chat("c2", 10_000, 20_000),
    chat("c3", 50_000, 5_000),
  ]);
  assert.equal(metrics.timeSplit?.modelMs, 35_000);
  assert.equal(metrics.timeSplit?.toolMs, 65_000);
});

test("without the root's total, human wait is the sum of the waits on the steps", () => {
  const metrics = buildRunMetrics([
    root(),
    chat("c1", 0, 10_000),
    tool("t1", 10_000, 9_000, { "ratel.wait.human_ms": 8_000 }),
    tool("t2", 20_000, 5_000, { "ratel.wait.human_ms": 4_000 }),
  ]);
  assert.equal(metrics.timeSplit?.humanWaitMs, 12_000);
});

test("a model call that covers the whole turn gives the wait back to the person", () => {
  const metrics = buildRunMetrics([
    root({ "ratel.run.human_wait_ms": 60_000 }),
    chat("c1", 0, 100_000),
  ]);
  assert.deepEqual(metrics.timeSplit, {
    totalMs: 100_000,
    modelMs: 40_000,
    humanWaitMs: 60_000,
    toolMs: 0,
  });
});

test("a run with no model call has no time split", () => {
  assert.equal(buildRunMetrics([root(), tool("t1", 0, 10)]).timeSplit, null);
});

test("lists the context size of each request of the main agent, in order", () => {
  const metrics = buildRunMetrics([
    root(),
    chat("c2", 30_000, 1_000, {
      inputTokens: 60_000,
      cachedTokens: 50_000,
      attributes: {
        "gen_ai.agent.name": "claude",
        "ratel.context.tokens": 61_000,
        "ratel.context.window": 200_000,
      },
    }),
    chat("c1", 0, 1_000, {
      inputTokens: 40_000,
      cachedTokens: 0,
      attributes: {
        "gen_ai.agent.name": "claude",
        "ratel.context.tokens": 41_000,
        "ratel.context.window": 200_000,
      },
    }),
    chat("s1", 10_000, 1_000, {
      inputTokens: 9_000,
      cachedTokens: 3_000,
      attributes: { "gen_ai.agent.name": "Explore", "ratel.context.tokens": 9_500 },
    }),
  ]);
  assert.deepEqual(
    metrics.requests.map((request) => [request.spanId, request.contextTokens, request.mainAgent]),
    [
      ["c1", 41_000, true],
      ["s1", 9_500, false],
      ["c2", 61_000, true],
    ],
  );
  assert.equal(metrics.contextWindow, 200_000);
  assert.equal(metrics.peakContextTokens, 61_000);
});

test("a request with no context size falls back to its input tokens", () => {
  const metrics = buildRunMetrics([root(), chat("c1", 0, 1_000, { inputTokens: 12_000 })]);
  assert.equal(metrics.requests[0].contextTokens, 12_000);
  assert.equal(metrics.contextWindow, null);
});

test("the cache hit rate is the cached share of the input tokens of every model call", () => {
  const metrics = buildRunMetrics([
    root(),
    chat("c1", 0, 1_000, { inputTokens: 40_000, cachedTokens: 0 }),
    chat("c2", 2_000, 1_000, { inputTokens: 60_000, cachedTokens: 50_000 }),
  ]);
  assert.deepEqual(metrics.cache, { inputTokens: 100_000, cachedTokens: 50_000, hitRate: 0.5 });
});

test("no input tokens, no cache hit rate", () => {
  assert.equal(buildRunMetrics([root(), chat("c1", 0, 1_000)]).cache, null);
});

test("reads where the run happened and how it ended from the root", () => {
  const metrics = buildRunMetrics([
    root({
      "ratel.run.repo": "demo/app",
      "ratel.run.branch": "feat/demo",
      "ratel.run.worktree": "demo-wt",
      "ratel.run.task": "DEMO-12",
      "ratel.run.pr": 7,
      "ratel.harness.name": "claude-code",
      "ratel.harness.version": "2.1.0",
      "ratel.harness.effort": "high",
      "ratel.harness.permission_mode": "acceptEdits",
      "ratel.run.outcome": "stopped",
      "ratel.run.tool_calls": 12,
      "ratel.run.tool_errors": 1,
      "ratel.run.commits": 2,
      "ratel.run.thinking_tokens": 900,
    }),
  ]);
  assert.deepEqual(metrics.context, {
    repo: "demo/app",
    branch: "feat/demo",
    worktree: "demo-wt",
    task: "DEMO-12",
    pr: 7,
    harness: "claude-code",
    harnessVersion: "2.1.0",
    effort: "high",
    permissionMode: "acceptEdits",
    outcome: "stopped",
  });
  assert.deepEqual(metrics.counters, [
    { key: "tool_calls", label: "Tool calls", value: 12 },
    { key: "tool_errors", label: "Tool errors", value: 1 },
    { key: "commits", label: "Commits", value: 2 },
    { key: "thinking_tokens", label: "Thinking tokens", value: 900 },
  ]);
});

test("a run with no run attribute has no context", () => {
  const metrics = buildRunMetrics([root()]);
  assert.equal(metrics.context, null);
  assert.deepEqual(metrics.counters, []);
});

test("turns compactions, permission decisions, hooks and waits into run events in time order", () => {
  const metrics = buildRunMetrics([
    root(
      {},
      {
        events: [
          {
            name: "ratel.hook",
            timeUnixMs: T0 + 5_000,
            attributes: {
              "ratel.hook.event": "PreToolUse",
              "ratel.hook.name": "lint",
              "ratel.hook.duration_ms": 120,
              "ratel.hook.outcome": "blocked",
            },
          },
          {
            name: "ratel.compaction",
            timeUnixMs: T0 + 50_000,
            attributes: {
              "ratel.compaction.trigger": "auto",
              "ratel.compaction.pre_tokens": 180_000,
              "ratel.compaction.post_tokens": 42_000,
            },
          },
          { name: "something.else", timeUnixMs: T0 + 1, attributes: {} },
        ],
      },
    ),
    span({
      spanId: "t1",
      offsetMs: 20_000,
      durationMs: 9_000,
      spanClass: "tool",
      events: [
        {
          name: "ratel.permission.decision",
          timeUnixMs: T0 + 28_000,
          attributes: {
            "gen_ai.tool.name": "Bash:git",
            "ratel.permission.decision": "deny",
            "ratel.permission.source": "user",
            "ratel.wait.human_ms": 8_000,
          },
        },
        {
          name: "ratel.human.wait",
          timeUnixMs: T0 + 21_000,
          attributes: {
            "gen_ai.tool.name": "AskUserQuestion",
            "ratel.wait.kind": "question",
            "ratel.wait.outcome": "timeout",
            "ratel.wait.human_ms": 300_000,
          },
        },
      ],
    }),
  ]);
  assert.deepEqual(
    metrics.events.map((event) => [
      event.kind,
      event.spanId,
      event.offsetMs,
      event.label,
      event.detail,
      event.tone,
    ]),
    [
      [
        "hook",
        "root",
        5_000,
        "Hook lint",
        `PreToolUse, blocked, ${formatDuration(120)}`,
        "warning",
      ],
      [
        "wait",
        "t1",
        21_000,
        "Waited for a person",
        `AskUserQuestion, question, no answer in time, ${formatDuration(300_000)}`,
        "warning",
      ],
      [
        "permission",
        "t1",
        28_000,
        "Permission denied",
        `Bash:git, by user, waited ${formatDuration(8_000)}`,
        "warning",
      ],
      [
        "compaction",
        "root",
        50_000,
        "Context compacted",
        "180,000 to 42,000 tokens, auto",
        "neutral",
      ],
    ],
  );
  assert.deepEqual(metrics.eventCounts, { compaction: 1, permission: 1, hook: 1, wait: 1 });
  // A blocked hook is not routine; one that passed is.
  assert.equal(metrics.events.some(isRoutineHook), false);
  assert.equal(isRoutineHook({ ...metrics.events[0], tone: "neutral" }), true);
});

test("reads a step's wait from its attributes", () => {
  assert.deepEqual(
    spanWait({
      "ratel.wait.kind": "permission",
      "ratel.wait.outcome": "declined",
      "ratel.wait.human_ms": 4_200,
    }),
    {
      kind: "permission",
      outcome: "declined",
      humanMs: 4_200,
      label: "Declined",
      refused: true,
    },
  );
  assert.equal(spanWait({ "ratel.wait.outcome": "approved" })?.refused, false);
  assert.equal(spanWait({}), null);
  assert.equal(spanWait(undefined), null);
});

test("says whether the run has anything to show", () => {
  assert.equal(buildRunMetrics([span({ spanId: "root", parentSpanId: null })]).empty, true);
  assert.equal(buildRunMetrics([root(), chat("c1", 0, 1_000)]).empty, false);
});
