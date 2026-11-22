import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition, ScorerConfigError } from "./config";
import { applicableScorers, scoreRecord } from "./engine";
import { resolvePath, transcriptOf, viewOf } from "./record";
import type { RunRecord, Scorer, ScorerDefinition } from "./types";

const RUN: RunRecord = {
  messages: [
    { role: "system", content: "You book flights." },
    { role: "user", content: "Book me a flight to Rome on Friday." },
    { role: "assistant", content: "Booked: flight AZ 123 to Rome, Friday 9:00." },
  ],
  toolCalls: [
    {
      name: "search_flights",
      arguments: { to: "Rome", day: "Friday" },
      result: [{ id: "AZ123" }],
      outcome: "ok",
      latencyMs: 420,
    },
    {
      name: "book_flight",
      arguments: { id: "AZ123" },
      result: { status: "booked" },
      outcome: "ok",
      latencyMs: 900,
    },
  ],
  finalAnswer: "Booked: flight AZ 123 to Rome, Friday 9:00.",
  answered: true,
  latencyMs: 2500,
  costUsd: 0.012,
  tokens: { input: 1800, output: 120 },
};

function scorer(definition: ScorerDefinition, extra: Partial<Scorer> = {}): Scorer {
  return {
    ...definition,
    id: extra.id ?? `s-${definition.kind}`,
    name: "test",
    scope: "task",
    taskId: "task-a",
    enabled: true,
    goodThreshold: 0.5,
    version: 1,
    ...extra,
  } as Scorer;
}

async function one(
  definition: ScorerDefinition,
  record: RunRecord = RUN,
  extra: Partial<Scorer> = {},
  ports = {},
) {
  const [result] = await scoreRecord(record, [scorer(definition, extra)], ports);
  return result!;
}

test("check reads latency, cost and tokens", async () => {
  assert.equal(
    (await one({ kind: "check", config: { path: "latencyMs", op: "lte", value: 3000 } })).status,
    "pass",
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "costUsd", op: "lt", value: 0.01 } })).status,
    "fail",
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "tokens.input", op: "gt", value: 1000 } })).status,
    "pass",
  );
});

test("check reads per-step latency over every step", async () => {
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolCalls.*.latencyMs", op: "lte", value: 1000 },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "toolCalls.*.latencyMs", op: "lte", value: 500 } }))
      .status,
    "fail",
  );
});

test("check reads tool called and not called", async () => {
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolNames", op: "contains", value: "book_flight" },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolNames", op: "not_contains", value: "cancel_flight" },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolNames", op: "contains", value: "cancel_flight" },
      })
    ).status,
    "fail",
  );
});

test("check matches tool arguments and results", async () => {
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolCalls.*.arguments.to", op: "eq", value: ["Rome"] },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolCalls.0.arguments.to", op: "matches", value: "^rom" },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "toolCalls.1.result.status", op: "eq", value: "booked" },
      })
    ).status,
    "pass",
  );
});

test("check reads message text by substring and by pattern", async () => {
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "messages.*.content", op: "contains", value: "rome" },
      })
    ).status,
    "pass",
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "finalAnswer", op: "matches", value: "AZ \\d+" } }))
      .status,
    "pass",
  );
  assert.equal(
    (
      await one({
        kind: "check",
        config: { path: "finalAnswer", op: "not_matches", value: "sorry" },
      })
    ).status,
    "pass",
  );
});

test("check skips an unknown value and reads exists", async () => {
  const unknown: RunRecord = { ...RUN, costUsd: null, toolCalls: null };
  assert.deepEqual(
    await one({ kind: "check", config: { path: "costUsd", op: "lte", value: 1 } }, unknown),
    {
      scorerId: "s-check",
      kind: "check",
      status: "skip",
      value: null,
      detail: "not measured",
    },
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "toolCallCount", op: "lte", value: 3 } }, unknown))
      .status,
    "skip",
  );
  assert.equal(
    (await one({ kind: "check", config: { path: "costUsd", op: "not_exists" } }, unknown)).status,
    "pass",
  );
});

test("expression evaluates JSONLogic over the run view", async () => {
  const logic = {
    and: [{ "<=": [{ var: "latencyMs" }, 3000] }, { in: ["book_flight", { var: "toolNames" }] }],
  };
  assert.equal((await one({ kind: "expression", config: { logic } })).status, "pass");
  const ratio = await one(
    { kind: "expression", config: { logic: { "/": [{ var: "tokens.output" }, 1000] } } },
    RUN,
    { goodThreshold: 0.1 },
  );
  assert.equal(ratio.value, 0.12);
  assert.equal(ratio.status, "pass");
  const every = { all: [{ var: "toolCalls" }, { "==": [{ var: "outcome" }, "ok"] }] };
  assert.equal((await one({ kind: "expression", config: { logic: every } })).status, "pass");
  assert.equal(
    (
      await one(
        { kind: "expression", config: { logic: { var: "costUsd" } } },
        { ...RUN, costUsd: null },
      )
    ).status,
    "skip",
  );
});

test("judge reads the whole transcript through its port", async () => {
  let seen = "";
  const judge = {
    judge: async (input: { criteria: string; transcript: string }) => {
      seen = input.transcript;
      return { value: 0.8, detail: "books the asked flight" };
    },
  };
  const result = await one(
    { kind: "judge", config: { criteria: "It books the flight the user asked for." } },
    RUN,
    {},
    { judge },
  );
  assert.deepEqual(result, {
    scorerId: "s-judge",
    kind: "judge",
    status: "pass",
    value: 0.8,
    detail: "books the asked flight",
  });
  assert.match(seen, /User: Book me a flight to Rome/);
  assert.match(seen, /Tool call: book_flight\(\{"id":"AZ123"\}\) \[ok\] -> \{"status":"booked"\}/);
  assert.match(seen, /Final answer: Booked/);
  assert.equal((await one({ kind: "judge", config: { criteria: "x" } })).status, "skip");
});

test("decision asks a closed-set question through its port", async () => {
  const config = {
    question: "Did the agent book the right flight?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
      { id: "unsure", label: "Unsure" },
    ],
    pass: ["yes"],
  };
  const decide = (answer: { choice: string; probabilities?: Record<string, number> } | null) => ({
    decision: { decide: async () => answer },
  });
  assert.equal(
    (await one({ kind: "decision", config }, RUN, {}, decide({ choice: "yes" }))).status,
    "pass",
  );
  assert.equal(
    (await one({ kind: "decision", config }, RUN, {}, decide({ choice: "no" }))).status,
    "fail",
  );
  const weighed = await one(
    { kind: "decision", config },
    RUN,
    {},
    decide({ choice: "yes", probabilities: { yes: 0.4, no: 0.35, unsure: 0.25 } }),
  );
  assert.deepEqual([weighed.status, weighed.value, weighed.detail], ["fail", 0.4, "Yes"]);
  assert.equal((await one({ kind: "decision", config }, RUN, {}, decide(null))).status, "skip");
});

test("two scorers of one kind both score", async () => {
  const results = await scoreRecord(RUN, [
    scorer(
      { kind: "check", config: { path: "latencyMs", op: "lte", value: 3000 } },
      { id: "fast" },
    ),
    scorer(
      { kind: "check", config: { path: "costUsd", op: "lte", value: 0.001 } },
      { id: "cheap" },
    ),
  ]);
  assert.deepEqual(
    results.map((result) => [result.scorerId, result.status]),
    [
      ["fast", "pass"],
      ["cheap", "fail"],
    ],
  );
});

test("applicableScorers adds suite scorers and applies the eval's switches", () => {
  const task = scorer(
    { kind: "check", config: { path: "latencyMs", op: "lte", value: 1 } },
    { id: "t" },
  );
  const off = scorer(
    { kind: "check", config: { path: "latencyMs", op: "lte", value: 1 } },
    { id: "t-off", enabled: false },
  );
  const suite = scorer(
    { kind: "judge", config: { criteria: "x" } },
    { id: "s", scope: "suite", taskId: null },
  );
  assert.deepEqual(
    applicableScorers([task, off], [suite]).map((s) => s.id),
    ["t", "s"],
  );
  assert.deepEqual(
    applicableScorers(
      [task, off],
      [suite],
      [
        { scorerId: "s", enabled: false },
        { scorerId: "t-off", enabled: true },
      ],
    ).map((s) => s.id),
    ["t", "t-off"],
  );
});

test("the view derives tool names, counts and how the run ended", () => {
  const view = viewOf({
    ...RUN,
    toolCalls: [
      ...RUN.toolCalls!,
      { name: "book_flight", arguments: null, result: null, outcome: "error", latencyMs: null },
    ],
  });
  assert.deepEqual(view.toolNames, ["search_flights", "book_flight", "book_flight"]);
  assert.equal(view.failedCalls, 1);
  assert.equal(view.endsWell, false);
  assert.equal(resolvePath(view, "toolCalls.length"), 3);
  assert.equal(resolvePath(view, "nothing.here"), undefined);
  assert.match(transcriptOf({ ...RUN, toolCalls: null }), /Which tools it called is not known/);
});

test("parseDefinition rejects an invalid JSONLogic expression with a clear message", () => {
  assert.throws(
    () => parseDefinition("expression", { logic: "latency < 3" }),
    (error: unknown) => error instanceof ScorerConfigError && /not JSONLogic/.test(error.message),
  );
  assert.throws(
    () => parseDefinition("expression", { logic: { regex: [{ var: "text" }, "x"] } }),
    /Unknown JSONLogic operator "regex"/,
  );
  assert.throws(
    () => parseDefinition("expression", { logic: { "<": [{ var: "latency" }, 3] } }),
    /variable "latency" does not start with a run field/,
  );
  assert.throws(
    () => parseDefinition("expression", { logic: { if: [true, { log: 1 }, 2] } }),
    /Unknown JSONLogic operator "log"/,
  );
  // Inside map and its kin, var reads the element, not the run.
  assert.deepEqual(
    parseDefinition("expression", {
      logic: { some: [{ var: "toolCalls" }, { "==": [{ var: "name" }, "x"] }] },
    }).kind,
    "expression",
  );
});

test("parseDefinition validates check, judge and decision configs", () => {
  assert.throws(
    () => parseDefinition("check", { path: "latency", op: "lte", value: 1 }),
    /does not start with a run field/,
  );
  assert.throws(
    () => parseDefinition("check", { path: "latencyMs", op: "below", value: 1 }),
    /Unknown check operator "below"/,
  );
  assert.throws(
    () => parseDefinition("check", { path: "latencyMs", op: "lte", value: "1" }),
    /needs a number value/,
  );
  assert.throws(
    () => parseDefinition("check", { path: "text", op: "matches", value: "(" }),
    /not a valid regular expression/,
  );
  assert.deepEqual(parseDefinition("check", { path: "costUsd", op: "exists", value: 3 }), {
    kind: "check",
    config: { path: "costUsd", op: "exists" },
  });
  assert.throws(() => parseDefinition("judge", { criteria: "  " }), /no criteria/);
  assert.throws(
    () =>
      parseDefinition("decision", {
        question: "Q?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        pass: ["c"],
      }),
    /"c" is not one of the options/,
  );
  assert.throws(
    () =>
      parseDefinition("decision", {
        question: "Q?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        pass: ["a", "b"],
      }),
    /Every option passes/,
  );
  assert.throws(() => parseDefinition("rubric", {}), /Unknown scorer kind "rubric"/);
});
