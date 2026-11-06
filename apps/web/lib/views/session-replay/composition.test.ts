import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "@/lib/ingest/categorize";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { type Composition, composition, lensMarkers } from "./composition";

const EVENT: CloudEvent = {
  provider: "anthropic",
  model: "m",
  ts: "2026-10-20T10:00:00Z",
  system: "You are helpful. <skills>skill one, skill two, skill three</skills>",
  tools: [
    {
      name: "get_trace",
      description: "Read a trace by id with all its spans",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
    { name: "search_docs", description: "Search the docs", parameters: { type: "object" } },
    {
      name: "never_used",
      description: "A tool the agent never calls in this session at all",
      parameters: { type: "object" },
    },
  ],
  messages: [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "get_trace", arguments: { id: "t1" } }],
    },
    {
      role: "tool",
      tool_call_id: "c1",
      content: "a long tool result with many many characters in it",
    },
    { role: "user", content: "follow-up" },
  ],
  usage: { input_tokens: 4000, output_tokens: 10, cached_tokens: 0 },
} as CloudEvent;

function metricsOf(event: CloudEvent, eventId = "e1") {
  const m = categorize(event);
  return {
    eventId,
    inputTokens: event.usage?.input_tokens ?? null,
    tokensByCategory: m.tokensByCategory,
    splits: m.splits,
    toolsByName: m.toolsByName,
  };
}

const sum = (c: Composition) => Object.values(c.parts).reduce((a, b) => a + b, 0);

test("the tools total matches categorize(), split into used and unused", () => {
  const c = composition({ ...metricsOf(EVENT), shape: null });
  const m = categorize(EVENT);
  assert.equal(c.parts.tools_used + c.parts.tools_unused, m.tokensByCategory.tools);
  assert.equal(c.parts.tools_used, m.splits.tools_used);
  assert.equal(sum(c), 4000);
});

test("without a payload shape, the base prompt stays in skills and tool results in history, and it says so", () => {
  const c = composition({ ...metricsOf(EVENT), shape: null });
  const m = categorize(EVENT);
  assert.equal(c.parts.system, 0);
  assert.equal(c.parts.skills, m.tokensByCategory.skills);
  assert.equal(c.parts.tool_results, 0);
  assert.equal(c.parts.history, m.tokensByCategory.history);
  assert.deepEqual(c.gaps, ["system_in_skills", "tool_results_in_history"]);
});

test("a payload shape splits the base prompt from skills and tool results from history, still summing to input_tokens", () => {
  const m = categorize(EVENT);
  const c = composition({
    ...metricsOf(EVENT),
    shape: { systemBaseChars: 300, skillChars: 100, toolResultChars: 600, messageChars: 800 },
  });
  assert.equal(c.parts.system + c.parts.skills, m.tokensByCategory.skills);
  assert.equal(c.parts.system, Math.round(m.tokensByCategory.skills * 0.75));
  assert.equal(c.parts.history + c.parts.tool_results, m.tokensByCategory.history);
  assert.ok(c.parts.tool_results > 0);
  assert.equal(sum(c), 4000);
  assert.deepEqual(c.gaps, []);
});

test("parts are rescaled to input_tokens when the stored split does not sum to it", () => {
  const c = composition({
    eventId: "e1",
    inputTokens: 200,
    tokensByCategory: { skills: 10, tools: 20, history: 30, memory: 0, user_input: 40 },
    splits: { tools_used: 5, tools_unused: 15, history_cached: 0, history_uncached: 30 },
    toolsByName: {},
    shape: null,
  });
  assert.equal(sum(c), 200);
  assert.deepEqual(
    [c.parts.skills, c.parts.tools_used, c.parts.tools_unused, c.parts.history, c.parts.user_input],
    [20, 10, 30, 60, 80],
  );
});

test("loaded tools are the tools with a footprint in the call", () => {
  const c = composition({ ...metricsOf(EVENT), shape: null });
  assert.deepEqual(c.loadedTools.map((tool) => tool.name).sort(), [
    "get_trace",
    "never_used",
    "search_docs",
  ]);
});

function call(
  eventId: string,
  inputTokens: number,
  history: number,
  toolResults: number,
  loaded: string[] = [],
): Composition {
  const parts = {
    system: 0,
    skills: 0,
    memory: 0,
    tools_used: 0,
    tools_unused: 0,
    history,
    tool_results: toolResults,
    user_input: inputTokens - history - toolResults,
  };
  return {
    eventId,
    inputTokens,
    parts,
    loadedTools: loaded.map((name) => ({ name, tokens: 10, calls: 0 })),
    gaps: [],
  };
}

test("bloat starts at the first call where history and tool results pass half the input, after the input doubled since the first", () => {
  const markers = lensMarkers(
    [
      call("e1", 1000, 600, 0),
      call("e2", 1500, 900, 0),
      call("e3", 2100, 900, 200),
      call("e4", 3000, 2000, 0),
    ],
    new Set(),
  );
  assert.equal(markers.bloatStart, "e3");
});

test("no bloat when the input never doubles", () => {
  assert.equal(
    lensMarkers([call("e1", 1000, 900, 0), call("e2", 1900, 1800, 0)], new Set()).bloatStart,
    null,
  );
});

test("unused tools: loaded in a call and never used anywhere in the session", () => {
  const markers = lensMarkers(
    [
      call("e1", 100, 0, 0, ["get_trace", "never_used"]),
      call("e2", 100, 0, 0, ["get_trace", "search_docs"]),
    ],
    new Set(["get_trace", "search_docs"]),
  );
  assert.deepEqual(markers.unusedTools, { e1: ["never_used"], e2: [] });
});
