import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunSummary, preview, type RunSpan, runAsk } from "./run-summary";

const T0 = Date.parse("2026-09-03T10:43:35.413Z");

function span(overrides: Partial<RunSpan> & { spanId: string; at?: number }): RunSpan {
  const startedAt = new Date(T0 + (overrides.at ?? 0));
  const durationMs = overrides.durationMs ?? 10;
  return {
    parentSpanId: "root",
    name: "step",
    spanClass: "other",
    operationName: null,
    model: null,
    startedAt,
    endedAt: new Date(startedAt.getTime() + durationMs),
    durationMs,
    statusCode: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    searchQuery: null,
    searchTarget: null,
    searchHitCount: null,
    attributes: {},
    ...overrides,
  };
}

const root = span({
  spanId: "root",
  parentSpanId: null,
  name: "agent.run",
  operationName: "agent.run",
  durationMs: 2772,
});

test("steps read in start order: model calls, tool calls and searches, each with its duration", () => {
  const summary = buildRunSummary([
    span({
      spanId: "s3",
      at: 2731,
      spanClass: "ratel_search",
      name: "capabilities.search",
      searchQuery: "create a migration",
      searchHitCount: 5,
      durationMs: 41,
    }),
    root,
    span({
      spanId: "s2",
      at: 0,
      spanClass: "llm_call",
      name: "chat",
      model: "gpt-5",
      inputTokens: 5144,
      outputTokens: 1707,
      costUsd: "0.029930",
      durationMs: 2731,
    }),
    span({ spanId: "s4", at: 2800, spanClass: "tool", name: "tool.ripgrep", durationMs: 181 }),
    span({ spanId: "s5", at: 2810, name: "cache.lookup" }),
  ]);
  assert.deepEqual(
    summary.steps.map((step) => [
      step.label,
      step.title,
      step.offsetMs,
      step.durationMs,
      step.detail,
    ]),
    [
      ["Model call", "gpt-5", 0, 2731, "6,851\u00a0tokens"],
      ["Search", "“create a migration”", 2731, 41, "5 results"],
      ["Tool call", "ripgrep", 2800, 181, null],
    ],
    "a plain step that went fine stays out of the story",
  );
  assert.equal(summary.status, "completed");
  assert.equal(summary.totals.tokens, 6851);
  assert.equal(summary.totals.costUsd, 0.02993);
  assert.equal(summary.totals.spanCount, 5);
  assert.equal(summary.totals.durationMs, 2981, "the run spans its first start to its last end");
  assert.equal(summary.title, "agent.run", "no captured ask: the root names the run");
  assert.equal(summary.contentCaptured, false);
});

test("failures are marked on their step with the error type, and any failure fails the run", () => {
  const summary = buildRunSummary([
    root,
    span({
      spanId: "s2",
      spanClass: "llm_call",
      name: "chat",
      model: "gpt-5",
      statusCode: 2,
      attributes: { "error.type": "upstream_timeout" },
    }),
    span({ spanId: "s3", at: 5, name: "db.write", statusCode: 2 }),
  ]);
  assert.equal(summary.status, "failed");
  assert.deepEqual(
    summary.steps.map((step) => [step.label, step.failed, step.errorType]),
    [
      ["Model call", true, "upstream_timeout"],
      ["Step", true, null],
    ],
    "a failed plain step joins the story",
  );
  assert.equal(summary.runError, null, "a step carries the failure");
});

test("a run whose top-level span has not arrived is incomplete, never completed", () => {
  const inFlight = buildRunSummary([
    span({ spanId: "s2", spanClass: "llm_call", name: "chat", model: "gpt-5" }),
    span({ spanId: "s3", at: 5, spanClass: "tool", name: "tool.ripgrep" }),
  ]);
  assert.equal(inFlight.status, "incomplete");
  assert.equal(inFlight.steps.length, 2, "the steps so far still read in order");
  const failing = buildRunSummary([
    span({ spanId: "s2", spanClass: "llm_call", name: "chat", statusCode: 2 }),
  ]);
  assert.equal(failing.status, "failed", "a failed step is a failure even before the run ends");
});

test("a run that failed at the root alone says so once", () => {
  const summary = buildRunSummary([
    { ...root, statusCode: 2, attributes: { "error.type": "cancelled" } },
    span({ spanId: "s2", spanClass: "llm_call", name: "chat" }),
  ]);
  assert.equal(summary.status, "failed");
  assert.equal(summary.runError, "cancelled");
  assert.equal(summary.steps.length, 1);
});

test("the ask is the last user message into the first model call, the answer the last reply", () => {
  const first = span({
    spanId: "s2",
    spanClass: "llm_call",
    name: "chat",
    attributes: {
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "an earlier question" }] },
        { role: "assistant", parts: [{ type: "text", content: "an earlier answer" }] },
        { role: "user", parts: [{ type: "text", content: "Where is order 1234?" }] },
      ]),
    },
  });
  const second = span({
    spanId: "s3",
    at: 50,
    spanClass: "llm_call",
    name: "chat",
    attributes: {
      "gen_ai.output.messages": JSON.stringify([
        {
          role: "assistant",
          parts: [{ type: "text", content: "It shipped yesterday." }],
          finish_reason: "stop",
        },
      ]),
    },
  });
  const summary = buildRunSummary([root, second, first]);
  assert.equal(summary.ask, "Where is order 1234?");
  assert.equal(summary.title, "Where is order 1234?");
  assert.equal(summary.answer, "It shipped yesterday.");
  assert.equal(summary.contentCaptured, true);
  assert.equal(runAsk([root]), null);
});

test("long runs list the first steps and count the rest", () => {
  const steps = Array.from({ length: 5 }, (_, index) =>
    span({ spanId: `t${index}`, at: index, spanClass: "tool", name: `tool.t${index}` }),
  );
  const summary = buildRunSummary([root, ...steps], 3);
  assert.equal(summary.steps.length, 3);
  assert.equal(summary.hiddenStepCount, 2);
});

test("previews collapse whitespace and cut at a word", () => {
  assert.equal(preview("  hello\n\n world  "), "hello world");
  assert.equal(preview("one two three four five", 16), "one two three…");
  assert.equal(preview(""), null);
});
