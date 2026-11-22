import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedParams,
  configPillText,
  diffWindow,
  groupBySession,
  initialRunView,
  inputSkeleton,
  modelOptions,
  type PlaygroundParam,
  paramDiff,
  paramErrors,
  paramOverrides,
  type RunViewState,
  reduceRunView,
  templateSegments,
} from "../playground-state";

/**
 * The playground's pure state: the param diff against the code defaults, the
 * config pill, the run view folded from SSE events, and the helpers the form
 * and the params panel draw from.
 */

const PARAMS: PlaygroundParam[] = [
  {
    name: "model",
    kind: "model",
    default: "anthropic/claude-sonnet-5-5",
    options: ["anthropic/claude-haiku-5-5", "openai/gpt-6"],
  },
  { name: "system", kind: "prompt", default: "You label {{workflow}}." },
  { name: "maxTokens", kind: "scalar", type: "int", default: 400, min: 50, max: 2000 },
  { name: "strict", kind: "scalar", type: "bool", default: false },
];

test("changedParams names only the params whose value differs from the code default", () => {
  assert.deepEqual(changedParams(PARAMS, {}), []);
  assert.deepEqual(
    changedParams(PARAMS, { maxTokens: 400, model: "anthropic/claude-sonnet-5-5" }),
    [],
  );
  assert.deepEqual(changedParams(PARAMS, { maxTokens: 300, system: "New", strict: false }), [
    "system",
    "maxTokens",
  ]);
  assert.deepEqual(
    changedParams(PARAMS, { unknown: 1 }),
    [],
    "a name the manifest does not have is not a change",
  );
});

test("paramOverrides sends only the changed params", () => {
  assert.deepEqual(
    paramOverrides(PARAMS, { maxTokens: 300, strict: false, model: "openai/gpt-6" }),
    { model: "openai/gpt-6", maxTokens: 300 },
  );
  assert.deepEqual(paramOverrides(PARAMS, {}), {});
});

test("paramDiff gives the default and the edited value of each changed param", () => {
  assert.deepEqual(paramDiff(PARAMS, { maxTokens: 300, strict: true }), [
    { name: "maxTokens", kind: "scalar", from: 400, to: 300 },
    { name: "strict", kind: "scalar", from: false, to: true },
  ]);
});

test("the pill says baseline = production config only with no edits and the production hash", () => {
  assert.equal(
    configPillText({ changed: [], configHash: "h1", productionHash: "h1" }),
    "baseline = production config",
  );
  assert.equal(
    configPillText({ changed: ["maxTokens"], configHash: "h1", productionHash: "h1" }),
    "1 changed: maxTokens",
  );
  assert.equal(
    configPillText({ changed: ["system", "maxTokens"], configHash: "h2", productionHash: "h1" }),
    "2 changed: system, maxTokens",
  );
  assert.equal(
    configPillText({ changed: [], configHash: "h2", productionHash: "h1" }),
    "code defaults, not production config",
  );
  assert.equal(
    configPillText({ changed: [], configHash: "h2", productionHash: null }),
    "code defaults",
  );
  assert.equal(
    configPillText({ changed: [], configHash: null, productionHash: null }),
    "code defaults",
  );
});

test("modelOptions lists the default, then the options of callable providers, once each", () => {
  const providers = [{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }];
  assert.deepEqual(modelOptions(PARAMS[0]!, providers, "builtin"), [
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
  ]);
  assert.deepEqual(
    modelOptions(
      { ...PARAMS[0]!, options: ["anthropic/claude-sonnet-5-5"] } as PlaygroundParam,
      providers,
      "builtin",
    ),
    ["anthropic/claude-sonnet-5-5"],
  );
  // A sandbox with its own resolver names engines, not providers: every option stays.
  assert.deepEqual(modelOptions(PARAMS[0]!, [], "custom"), [
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
    "openai/gpt-6",
  ]);
});

test("templateSegments marks {{var}} and ${var} as variables", () => {
  assert.deepEqual(templateSegments("Hi {{name}}, see ${ doc } now"), [
    { text: "Hi ", variable: false },
    { text: "{{name}}", variable: true },
    { text: ", see ", variable: false },
    { text: "${ doc }", variable: true },
    { text: " now", variable: false },
  ]);
  assert.deepEqual(templateSegments("plain"), [{ text: "plain", variable: false }]);
});

test("inputSkeleton fills a structured input with empty strings, arrays and nested objects", () => {
  const schema = {
    type: "object",
    properties: {
      workflowId: { type: "string" },
      asks: { type: "array", items: { type: "string" } },
      limit: { type: "integer" },
      strict: { type: "boolean" },
      owner: { type: "object", properties: { name: { type: "string" } } },
      pick: { enum: ["a", "b"] },
    },
  };
  assert.deepEqual(inputSkeleton(schema), {
    workflowId: "",
    asks: [],
    limit: 0,
    strict: false,
    owner: { name: "" },
    pick: "a",
  });
  assert.deepEqual(inputSkeleton({}), {});
});

test("paramErrors maps a 400 invalid_params body to a message per param", () => {
  assert.deepEqual(
    paramErrors({
      error: "invalid_params",
      params: [{ param: "maxTokens", message: "must be at most 2000" }],
    }),
    {
      maxTokens: "must be at most 2000",
    },
  );
  assert.deepEqual(
    paramErrors({ error: "invalid_input", message: "input.asks must be array" }),
    {},
  );
  assert.deepEqual(paramErrors(null), {});
});

test("groupBySession keeps the newest-first order and puts each session's runs together", () => {
  const runs = [
    { id: "r4", sessionId: "s2" },
    { id: "r3", sessionId: "s1" },
    { id: "r2", sessionId: "s2" },
    { id: "r1", sessionId: null },
  ];
  assert.deepEqual(
    groupBySession(runs).map((g) => [g.sessionId, g.runs.map((r) => r.id)]),
    [
      ["s2", ["r4", "r2"]],
      ["s1", ["r3"]],
      [null, ["r1"]],
    ],
  );
});

function fold(
  state: RunViewState,
  ...actions: Parameters<typeof reduceRunView>[1][]
): RunViewState {
  return actions.reduce(reduceRunView, state);
}

test("the run view folds text, logs, tool calls and the end into one state", () => {
  const started = fold(initialRunView, {
    type: "started",
    runId: "run1",
    sessionId: "s1",
    configHash: "h1",
    overrides: ["maxTokens"],
    at: 1_000,
  });
  assert.equal(started.phase, "live");
  assert.equal(started.runId, "run1");

  const done = fold(
    started,
    {
      type: "event",
      seq: 1,
      kind: "log",
      payload: { kind: "log", level: "info", message: "prompt built" },
    },
    { type: "event", seq: 2, kind: "text.delta", payload: { kind: "text.delta", text: "Hel" } },
    { type: "event", seq: 3, kind: "text.delta", payload: { kind: "text.delta", text: "lo" } },
    { type: "event", seq: 3, kind: "text.delta", payload: { kind: "text.delta", text: "lo" } },
    {
      type: "event",
      seq: 4,
      kind: "tool.call",
      payload: { kind: "tool.call", callId: "c1", tool: "search", args: { q: "x" }, mode: "real" },
    },
    {
      type: "event",
      seq: 5,
      kind: "tool.result",
      payload: { kind: "tool.result", callId: "c1", result: [1], isError: false, mode: "real" },
    },
    {
      type: "event",
      seq: 6,
      kind: "run.end",
      payload: {
        status: "ok",
        output: { name: "Refunds" },
        usage: { inputTokens: 12, outputTokens: 5 },
        traceId: "t1",
        overrides: ["maxTokens"],
      },
      at: 3_500,
    },
    { type: "status", status: "ok", error: null, at: 3_600 },
  );

  assert.equal(done.text, "Hello", "a repeated seq is folded once");
  assert.deepEqual(done.logs, [{ level: "info", message: "prompt built" }]);
  assert.deepEqual(done.tools, [
    {
      callId: "c1",
      tool: "search",
      args: { q: "x" },
      mode: "real",
      result: [1],
      isError: false,
      fakeSource: null,
      confirmDecision: null,
      done: true,
    },
  ]);
  assert.deepEqual(done.output, { name: "Refunds" });
  assert.deepEqual(done.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(done.traceId, "t1");
  assert.equal(done.status, "ok");
  assert.equal(done.phase, "ended");
  assert.equal(done.latencyMs, 2_500);
  assert.equal(done.lastSeq, 6);
});

test("an error end and a lost status carry their message", () => {
  const started = fold(initialRunView, {
    type: "started",
    runId: "r",
    sessionId: "s",
    configHash: "h",
    overrides: [],
    at: 0,
  });
  const failed = fold(started, {
    type: "event",
    seq: 1,
    kind: "run.end",
    payload: { status: "error", error: { code: "run_failed", message: "no Claude backend" } },
    at: 10,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "no Claude backend");

  const lost = fold(started, {
    type: "status",
    status: "lost",
    error: { code: "lost", message: "The runner stopped sending a lease." },
    at: 5,
  });
  assert.equal(lost.phase, "ended");
  assert.equal(lost.status, "lost");
  assert.equal(lost.error, "The runner stopped sending a lease.");
});

test("a refused start keeps the run idle with the message", () => {
  const refused = fold(
    initialRunView,
    { type: "starting" },
    { type: "refused", message: "Your runner is offline." },
  );
  assert.equal(refused.phase, "idle");
  assert.equal(refused.error, "Your runner is offline.");
});

test("diffWindow shows a long text from shortly before its first change", () => {
  const head = "x".repeat(200);
  const from = `${head}\nNever use em dashes.`;
  const to = `${head}\nNever use em dashes.\nAnswer in three words.`;
  const window = diffWindow(from, to);
  assert.ok(window.from.startsWith("…"));
  assert.ok(window.to.endsWith("Answer in three words."));
  assert.ok(window.to.length < 80);
});

test("diffWindow keeps short and non-text values as they are", () => {
  assert.deepEqual(diffWindow("short", "shorter"), { from: "short", to: "shorter" });
  assert.deepEqual(diffWindow(400, 300), { from: "400", to: "300" });
});
