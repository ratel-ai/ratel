import assert from "node:assert/strict";
import { test } from "node:test";
import { type EvalTarget, selectEvals, type TraceTarget } from "./select";
import { fixture } from "./test-support";

// The demo support agent: its evals, each row with the tools it exercises, and recent traces.
const EVALS: EvalTarget[] = [
  {
    id: "e-refunds",
    name: "Refunds",
    tools: ["lookup_order", "refund_order"],
    rows: [
      { id: "r-damaged", tools: ["lookup_order", "refund_order"] },
      { id: "r-status-only", tools: ["lookup_order"] },
    ],
  },
  {
    id: "e-status",
    name: "Order status",
    tools: ["lookup_order"],
    rows: [
      { id: "s-late", tools: ["lookup_order"] },
      { id: "s-lost", tools: ["lookup_order"] },
    ],
  },
  {
    id: "e-shipping",
    name: "Shipping questions",
    tools: [],
    prompts: ["shipping_policy"],
    rows: [{ id: "q-when", tools: [] }],
  },
  {
    id: "e-tone",
    name: "Tone",
    tools: [],
    paths: ["src/persona/**"],
    rows: [{ id: "t-rude", tools: [] }],
  },
];
const TRACES: TraceTarget[] = [
  { id: "trace-refund", tools: ["lookup_order", "refund_order"] },
  { id: "trace-status", tools: ["lookup_order"] },
  { id: "trace-chat", tools: [] },
];

// The tools the version declares (its ratel.yaml), whether an eval uses them or not.
const TOOLS = ["lookup_order", "refund_order"];

const select = (diff: string) => selectEvals({ diff, tools: TOOLS, evals: EVALS, traces: TRACES });
const picked = (selection: ReturnType<typeof select>) =>
  selection.evals.map((e) => [e.id, e.rows] as const);

test("a changed tool selects the evals and the rows that use it, and its traces", () => {
  const selection = select(fixture("refund-tool.diff"));
  assert.equal(selection.mode, "some");
  assert.deepEqual(picked(selection), [["e-refunds", ["r-damaged"]]]);
  assert.deepEqual(selection.evals[0].reasons, ["uses refund_order"]);
  assert.deepEqual(selection.change.tools, ["refund_order"]);
  assert.deepEqual(selection.change.ignored, ["README.md", "src/tools/refund_order.test.ts"]);
  assert.deepEqual(
    selection.skipped.map((e) => e.id),
    ["e-status", "e-shipping", "e-tone"],
  );
  assert.deepEqual(selection.traces, ["trace-refund"]);
});

test("a tool changed in ratel.yaml selects every eval and row that uses it", () => {
  const selection = select(fixture("tool-mode.diff"));
  assert.equal(selection.mode, "some");
  assert.deepEqual(picked(selection), [
    ["e-refunds", ["r-damaged", "r-status-only"]],
    ["e-status", ["s-late", "s-lost"]],
  ]);
  assert.deepEqual(selection.traces, ["trace-refund", "trace-status"]);
});

test("a model change in ratel.yaml selects every eval, every row", () => {
  const selection = select(fixture("model-change.diff"));
  assert.equal(selection.mode, "all");
  assert.deepEqual(selection.change.global, ["ratel.yaml changes model"]);
  assert.deepEqual(
    picked(selection),
    EVALS.map((e) => [e.id, "all"]),
  );
  assert.deepEqual(selection.traces, ["trace-refund", "trace-status", "trace-chat"]);
});

test("a change to docs and CI only selects nothing", () => {
  const selection = select(fixture("docs-only.diff"));
  assert.equal(selection.mode, "none");
  assert.deepEqual(selection.evals, []);
  assert.deepEqual(selection.change.ignored, ["docs/setup.md", ".github/workflows/ci.yml"]);
  assert.match(selection.reason, /nothing the agent runs/);
});

test("a changed prompt selects the evals that use it, all their rows", () => {
  const selection = select(fixture("prompt-change.diff"));
  assert.equal(selection.mode, "some");
  assert.deepEqual(picked(selection), [["e-shipping", "all"]]);
  assert.deepEqual(selection.evals[0].reasons, ["uses the prompt shipping_policy"]);
});

test("a path an eval declares selects it", () => {
  const diff = [
    "diff --git a/src/persona/voice.ts b/src/persona/voice.ts",
    "index 1..2 100644",
    "--- a/src/persona/voice.ts",
    "+++ b/src/persona/voice.ts",
    "@@ -1 +1 @@",
    '-export const voice = "warm";',
    '+export const voice = "brisk";',
  ].join("\n");
  const selection = select(diff);
  assert.deepEqual(picked(selection), [["e-tone", "all"]]);
  assert.deepEqual(selection.evals[0].reasons, ["covers src/persona/voice.ts"]);
});

test("code no eval maps to selects every eval: missing a regression costs more", () => {
  const selection = select(fixture("unmapped-code.diff"));
  assert.equal(selection.mode, "all");
  assert.deepEqual(selection.change.unmapped, ["src/format.ts"]);
  assert.match(selection.reason, /src\/format\.ts/);
  assert.equal(selection.evals.length, EVALS.length);
});

test("a changed tool that no eval uses is named as untested", () => {
  const selection = selectEvals({
    diff: fixture("refund-tool.diff"),
    tools: TOOLS,
    evals: EVALS.filter((e) => e.id !== "e-refunds"),
    traces: [],
  });
  assert.equal(selection.mode, "none");
  assert.deepEqual(selection.untestedTools, ["refund_order"]);
  assert.match(selection.reason, /refund_order changed, and no eval uses it/);
});

test("a dependency or Dockerfile change selects every eval", () => {
  const diff = [
    "diff --git a/agent/Dockerfile b/agent/Dockerfile",
    "index 1..2 100644",
    "--- a/agent/Dockerfile",
    "+++ b/agent/Dockerfile",
    "@@ -1 +1 @@",
    "-FROM node:22",
    "+FROM node:24",
  ].join("\n");
  const selection = select(diff);
  assert.equal(selection.mode, "all");
  assert.deepEqual(selection.change.global, ["agent/Dockerfile changes the build"]);
});

test("a tool named in camelCase in code matches its snake_case name", () => {
  const diff = [
    "diff --git a/src/agent.ts b/src/agent.ts",
    "index 1..2 100644",
    "--- a/src/agent.ts",
    "+++ b/src/agent.ts",
    "@@ -1 +1 @@",
    "-const tools = [lookupOrder, refundOrder];",
    "+const tools = [lookupOrder];",
  ].join("\n");
  const selection = select(diff);
  assert.deepEqual(selection.change.tools, ["lookup_order", "refund_order"]);
  assert.equal(selection.mode, "some");
});

test("the trace list is capped", () => {
  const selection = selectEvals({
    diff: fixture("model-change.diff"),
    tools: TOOLS,
    evals: EVALS,
    traces: TRACES,
    traceLimit: 2,
  });
  assert.deepEqual(selection.traces, ["trace-refund", "trace-status"]);
});

const MONOREPO = [
  "diff --git a/website/src/pages/pricing.tsx b/website/src/pages/pricing.tsx",
  "index 1..2 100644",
  "--- a/website/src/pages/pricing.tsx",
  "+++ b/website/src/pages/pricing.tsx",
  "@@ -1 +1 @@",
  "-<h1>Pricing</h1>",
  "+<h1>Plans and pricing</h1>",
  "diff --git a/agents/support/src/tools/refund_order.ts b/agents/support/src/tools/refund_order.ts",
  "index 1..2 100644",
  "--- a/agents/support/src/tools/refund_order.ts",
  "+++ b/agents/support/src/tools/refund_order.ts",
  "@@ -1 +1 @@",
  "-  return payments.refund(order);",
  "+  return payments.refund(order, { once: true });",
].join("\n");

test("in a monorepo, a change outside the agent's folder touches nothing", () => {
  const selection = selectEvals({
    diff: MONOREPO,
    root: "agents/support",
    tools: TOOLS,
    evals: EVALS,
    traces: TRACES,
  });
  assert.equal(selection.mode, "some");
  assert.deepEqual(selection.change.outside, ["website/src/pages/pricing.tsx"]);
  assert.deepEqual(selection.change.tools, ["refund_order"]);
  assert.deepEqual(picked(selection), [["e-refunds", ["r-damaged"]]]);
});

test("the agent's own ratel.yaml and paths are read from its folder", () => {
  const diff = fixture("model-change.diff").replaceAll("ratel.yaml", "agents/support/ratel.yaml");
  const selection = selectEvals({
    diff,
    root: "agents/support",
    tools: TOOLS,
    evals: EVALS,
    traces: TRACES,
  });
  assert.deepEqual(selection.change.global, ["agents/support/ratel.yaml changes model"]);
});

test("a file the rule cannot map takes what the decision model read in it", () => {
  const base = { diff: fixture("unmapped-code.diff"), tools: TOOLS, evals: EVALS, traces: TRACES };
  const asTool = selectEvals({
    ...base,
    resolved: { "src/format.ts": { kind: "tool", tool: "refund_order", confidence: 0.91 } },
  });
  assert.equal(asTool.mode, "some");
  assert.deepEqual(asTool.change.unmapped, []);
  assert.deepEqual(asTool.change.classified, [
    { path: "src/format.ts", as: "refund_order", confidence: 0.91 },
  ]);
  assert.deepEqual(picked(asTool), [["e-refunds", ["r-damaged"]]]);

  const outside = selectEvals({
    ...base,
    resolved: { "src/format.ts": { kind: "outside", confidence: 0.95 } },
  });
  assert.equal(outside.mode, "none");
  assert.deepEqual(outside.change.outside, ["src/format.ts"]);

  const shared = selectEvals({
    ...base,
    resolved: { "src/format.ts": { kind: "shared", confidence: 0.88 } },
  });
  assert.equal(shared.mode, "all");
  assert.deepEqual(shared.change.global, ["src/format.ts is code every run goes through"]);
});
