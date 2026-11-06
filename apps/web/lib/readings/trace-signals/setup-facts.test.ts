import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSetupFacts,
  missingSetup,
  parseStoredSetup,
  type SetupCounts,
} from "@/lib/readings/trace-signals/setup-facts";

const NONE: SetupCounts = {
  otel: {
    toolRows: 0,
    toolRowsWithSession: 0,
    toolRowsWithUser: 0,
    toolRowsWithResult: 0,
    modelCalls: 0,
    modelCallsWithPrompt: 0,
    modelCallsWithMenu: 0,
  },
  sdk: {
    searches: 0,
    searchesWithQuery: 0,
    turns: 0,
    declaredTurns: 0,
    turnsWithTools: 0,
    userMessages: 0,
    events: 0,
    eventsWithUser: 0,
  },
};

test("an OpenTelemetry project with content off and no conversation id is told exactly that", () => {
  const setup = buildSetupFacts({
    ...NONE,
    otel: {
      toolRows: 200,
      toolRowsWithSession: 0,
      toolRowsWithUser: 200,
      toolRowsWithResult: 0,
      modelCalls: 300,
      modelCallsWithPrompt: 0,
      modelCallsWithMenu: 0,
    },
  });
  assert.deepEqual(setup.lanes, { sdk: false, otel: true });
  const status = Object.fromEntries(setup.facts.map((f) => [f.key, f.status]));
  assert.deepEqual(status, {
    otel_tool_spans: "on",
    otel_model_calls: "on",
    otel_conversation_id: "off",
    otel_user_id: "on",
    otel_content: "off",
    otel_tool_definitions: "off",
    // 200 tool calls, none alone in its trace: one request is one run.
    otel_trace_context: "on",
  });
  assert.deepEqual(
    missingSetup(setup).map((f) => f.key),
    ["otel_conversation_id", "otel_content", "otel_tool_definitions"],
  );
});

test("an SDK project gets SDK facts only; a partial share reads as partial", () => {
  const setup = buildSetupFacts({
    ...NONE,
    sdk: {
      searches: 100,
      searchesWithQuery: 100,
      turns: 50,
      declaredTurns: 20,
      turnsWithTools: 50,
      userMessages: 0,
      events: 400,
      eventsWithUser: 400,
    },
  });
  assert.deepEqual(setup.lanes, { sdk: true, otel: false });
  assert.deepEqual(
    setup.facts.map((f) => [f.key, f.status, f.share]),
    [
      ["sdk_tool_calls", "on", 1],
      ["sdk_search_queries", "on", 1],
      ["sdk_turn_ids", "partial", 0.4],
      ["sdk_user_messages", "off", 0],
      ["sdk_end_users", "on", 1],
    ],
  );
});

test("an SDK project that only searches is told no tool calls arrive; one that never searches is not asked for queries", () => {
  const searchOnly = buildSetupFacts({
    ...NONE,
    sdk: { ...NONE.sdk, searches: 80, searchesWithQuery: 80, turns: 40, events: 80 },
  });
  assert.equal(searchOnly.facts.find((f) => f.key === "sdk_tool_calls")?.status, "off");
  const someTools = buildSetupFacts({
    ...NONE,
    sdk: { ...NONE.sdk, turns: 40, turnsWithTools: 20, events: 80 },
  });
  assert.equal(
    someTools.facts.find((f) => f.key === "sdk_tool_calls")?.status,
    "on",
    "half the runs calling a tool is enough",
  );
  assert.equal(
    someTools.facts.some((f) => f.key === "sdk_search_queries"),
    false,
  );
});

test("user messages count against runs; mixed runs warn only on the SDK lane and survive a round trip", () => {
  const setup = buildSetupFacts(
    {
      ...NONE,
      sdk: {
        ...NONE.sdk,
        turns: 100,
        turnsWithTools: 100,
        declaredTurns: 100,
        userMessages: 60,
        events: 300,
      },
    },
    undefined,
    { mixedRuns: true },
  );
  assert.deepEqual(
    setup.facts.find((f) => f.key === "sdk_user_messages"),
    { key: "sdk_user_messages", status: "partial", share: 0.6 },
  );
  assert.deepEqual(setup.warnings, ["mixed_runs"]);
  assert.deepEqual(parseStoredSetup(JSON.parse(JSON.stringify(setup)))?.warnings, ["mixed_runs"]);
  const otelOnly = buildSetupFacts({ ...NONE, otel: { ...NONE.otel, toolRows: 5 } }, undefined, {
    mixedRuns: true,
  });
  assert.equal(otelOnly.warnings, undefined);
  assert.equal(parseStoredSetup({ ...setup, warnings: ["junk"] })?.warnings, undefined);
});

test("both lanes list both sets; no data lists nothing", () => {
  const both = buildSetupFacts({
    otel: {
      ...NONE.otel,
      toolRows: 10,
      modelCalls: 10,
      modelCallsWithPrompt: 10,
      modelCallsWithMenu: 10,
      toolRowsWithSession: 10,
      toolRowsWithUser: 10,
    },
    sdk: {
      ...NONE.sdk,
      events: 10,
      searches: 2,
      searchesWithQuery: 2,
      turns: 2,
      declaredTurns: 2,
      turnsWithTools: 2,
      userMessages: 2,
      eventsWithUser: 10,
    },
  });
  assert.equal(both.facts.length, 11);
  assert.equal(missingSetup(both).length, 0);
  assert.deepEqual(buildSetupFacts(NONE).facts, []);
});

test("stored setup parses defensively", () => {
  const stored = buildSetupFacts({
    ...NONE,
    sdk: { ...NONE.sdk, events: 1, searches: 1, searchesWithQuery: 1, turns: 1 },
  });
  assert.deepEqual(parseStoredSetup(JSON.parse(JSON.stringify(stored))), stored);
  assert.equal(parseStoredSetup(null), null);
  assert.equal(parseStoredSetup({ version: 2 }), null);
  assert.deepEqual(
    parseStoredSetup({
      version: 1,
      lanes: { sdk: true },
      facts: [{ key: "bogus", status: "on", share: 1 }],
    })?.facts,
    [],
  );
});
