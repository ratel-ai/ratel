import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOtelFacts,
  type OtelFactRow,
  otelTraceIdOf,
} from "@/lib/readings/trace-signals/signals/otel-facts";

function row(over: Partial<OtelFactRow> & Pick<OtelFactRow, "id" | "type">): OtelFactRow {
  return {
    traceId: "t1",
    errorType: null,
    resultEmpty: null,
    argHash: null,
    inputTokens: null,
    outputTokens: null,
    menu: null,
    ...over,
  };
}

test("step facts keep only calls that carry a fact, keyed by trace event id", () => {
  const facts = buildOtelFacts([
    row({ id: "e1", type: "invoke_error", errorType: "ToolNotFound" }),
    row({ id: "e2", type: "invoke_error" }),
    row({ id: "e3", type: "invoke_end", resultEmpty: true }),
    row({ id: "e4", type: "invoke_end", argHash: "abc" }),
    row({ id: "e5", type: "invoke_end" }),
  ]);
  assert.deepEqual(facts.stepFacts.get("e1"), {
    errorType: "ToolNotFound",
    resultEmpty: null,
    argHash: null,
    agent: null,
  });
  assert.equal(
    facts.stepFacts.get("e2")?.errorType,
    "error",
    "an error without a type still reads as an error",
  );
  assert.equal(facts.stepFacts.get("e3")?.resultEmpty, true);
  assert.equal(facts.stepFacts.get("e4")?.argHash, "abc");
  assert.equal(facts.stepFacts.has("e5"), false, "a plain ok call adds nothing");
  assert.equal(facts.traces.size, 0, "tool calls are not model round trips");
});

test("model calls fold per trace: round trips, tokens, the menu union and the calls that carried one", () => {
  const facts = buildOtelFacts([
    row({
      id: "m1",
      type: "otlp_model_call",
      inputTokens: 100,
      outputTokens: 10,
      menu: ["a", "b"],
    }),
    row({
      id: "m2",
      type: "otlp_model_call",
      inputTokens: 50,
      outputTokens: null,
      menu: ["b", "c"],
    }),
    row({ id: "m3", type: "otlp_model_call", inputTokens: null, outputTokens: 5 }),
    row({ id: "m4", type: "otlp_model_call", traceId: "t2", menu: [] }),
    row({ id: "m5", type: "otlp_model_call", traceId: null, menu: ["x"] }),
  ]);
  const t1 = facts.traces.get("t1");
  assert.equal(t1?.modelCalls, 3);
  assert.equal(t1?.inputTokens, 150);
  assert.equal(t1?.outputTokens, 15);
  assert.deepEqual([...(t1?.menus ?? [])].sort(), ["a", "b", "c"]);
  assert.equal(t1?.menuCalls, 2);
  assert.equal(facts.traces.get("t2")?.menuCalls, 0, "an empty menu is no menu");
  assert.equal(facts.traces.size, 2, "a model call without a trace is dropped");
});

test("an OTLP-lane turn maps to its trace through its turn key", () => {
  assert.equal(otelTraceIdOf({ lane: "otlp", turnKey: "otlp:abc123" }), "abc123");
  assert.equal(otelTraceIdOf({ lane: "otlp", turnKey: undefined }), null);
  assert.equal(otelTraceIdOf({ lane: "otlp", turnKey: "otlp:" }), null);
  assert.equal(otelTraceIdOf({ lane: "runtime", turnKey: "otlp:abc" }), null, "only the OTLP lane");
  assert.equal(otelTraceIdOf({ lane: "otlp", turnKey: "declared:x" }), null);
});
