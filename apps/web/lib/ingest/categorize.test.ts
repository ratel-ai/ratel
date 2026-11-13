import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "@/lib/ingest/categorize";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { CONTEXT_SOURCES } from "@/lib/ingest/context";

// The fixtures are already valid CloudEvent shapes; ingest no longer Zod-validates
// (OTLP reconstruction builds these internally), so a cast stands in for the parse.
const parse = (raw: unknown): CloudEvent => raw as CloudEvent;

const sumCategories = (t: Record<string, number>) => CONTEXT_SOURCES.reduce((s, k) => s + t[k], 0);

test("category tokens reconcile to usage.input_tokens", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    system: "You are a weather assistant.",
    tools: [
      { name: "get_weather", description: "Look up weather.", parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_call", id: "c", name: "get_weather", arguments: { location: "Paris" } },
        ],
      },
      { role: "tool", tool_call_id: "c", content: "18°C, cloudy" },
    ],
    usage: { input_tokens: 82, output_tokens: 41, cached_tokens: 0 },
  });
  const m = categorize(ev);
  assert.equal(sumCategories(m.tokensByCategory), 82);
});

test("tools split by whether the model called them", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    tools: [
      { name: "used_tool", description: "d".repeat(200), parameters: { type: "object" } },
      { name: "dead_tool_a", description: "d".repeat(200), parameters: { type: "object" } },
      { name: "dead_tool_b", description: "d".repeat(200), parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c", name: "used_tool", arguments: {} }],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 10 },
  });
  const m = categorize(ev);
  assert.equal(m.toolsTotalCount, 3);
  assert.equal(m.toolsUsedCount, 1);
  assert.ok(m.splits.tools_unused > 0, "unused tools should carry tokens");
  assert.equal(m.splits.tools_used + m.splits.tools_unused, m.tokensByCategory.tools);

  // Per-tool map: every def present, calls only on the invoked one, and the
  // per-tool token footprints sum back to the tools total (and to the split).
  assert.deepEqual(Object.keys(m.toolsByName).sort(), ["dead_tool_a", "dead_tool_b", "used_tool"]);
  assert.equal(m.toolsByName.used_tool.calls, 1);
  assert.equal(m.toolsByName.dead_tool_a.calls, 0);
  const perToolTotal = Object.values(m.toolsByName).reduce((s, t) => s + t.tokens, 0);
  assert.equal(perToolTotal, m.tokensByCategory.tools);
  assert.equal(m.toolsByName.used_tool.tokens, m.splits.tools_used);
});

test("toolsByName counts repeated calls to the same tool", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    tools: [{ name: "search", description: "d".repeat(80), parameters: { type: "object" } }],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "a", name: "search", arguments: {} },
          { type: "tool_call", id: "b", name: "search", arguments: {} },
        ],
      },
    ],
    usage: { input_tokens: 500, output_tokens: 10 },
  });
  const m = categorize(ev);
  assert.equal(m.toolsByName.search.calls, 2);
  assert.equal(m.toolsUsedCount, 1);
});

test("skills and memory are extracted from the system prompt", () => {
  const ev = parse({
    provider: "anthropic",
    model: "claude-opus-4-8",
    ts: "2026-06-30T12:00:00Z",
    system:
      "Base instructions.\n<skill>A long skill body ".repeat(1) +
      "x".repeat(400) +
      "</skill>\n<memory>" +
      "y".repeat(400) +
      "</memory>",
    messages: [
      { role: "user", content: "older turn" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "current turn" },
    ],
    usage: { input_tokens: 5000, output_tokens: 10 },
  });
  const m = categorize(ev);
  assert.ok(m.tokensByCategory.skills > 0, "skills detected");
  assert.ok(m.tokensByCategory.memory > 0, "memory detected");
  assert.ok(m.tokensByCategory.user_input > 0, "current user turn attributed");
  assert.ok(m.tokensByCategory.history > 0, "prior turns are history");
  assert.equal(sumCategories(m.tokensByCategory), 5000);
});

test("cached tokens spill past the prefix into history", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    messages: [
      { role: "user", content: "q1 ".repeat(200) },
      { role: "assistant", content: "a1 ".repeat(200) },
      { role: "user", content: "current" },
    ],
    usage: { input_tokens: 1000, output_tokens: 5, cached_tokens: 400 },
  });
  const m = categorize(ev);
  // No system/tools → prefix is 0, so all 400 cached land in history.
  assert.equal(m.splits.history_cached, Math.min(m.tokensByCategory.history, 400));
  assert.equal(m.splits.history_cached + m.splits.history_uncached, m.tokensByCategory.history);
});

test("empty message content with real usage still reconciles to input_tokens", () => {
  // Every segment estimates to zero (empty content) but the model reports input
  // tokens — they must be attributed (to the current turn), not silently dropped.
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    messages: [{ role: "user", content: "" }],
    usage: { input_tokens: 7, output_tokens: 0 },
  });
  const m = categorize(ev);
  assert.equal(sumCategories(m.tokensByCategory), 7);
  assert.equal(m.tokensByCategory.user_input, 7);
});

test("a tool defined twice counts once in the total/used tool counts", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    tools: [
      { name: "search", description: "d".repeat(50), parameters: { type: "object" } },
      { name: "search", description: "d".repeat(50), parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "a", name: "search", arguments: {} }],
      },
    ],
    usage: { input_tokens: 500, output_tokens: 10 },
  });
  const m = categorize(ev);
  assert.equal(m.toolsTotalCount, 1, "distinct tool names, not definitions");
  assert.equal(m.toolsUsedCount, 1);
});

test("Ratel gateway: invoke_tool calls are unwrapped to the inner tool", () => {
  // A gateway agent sees only the meta-tools; the real tool ran nests its id in
  // the invoke_tool call's `arguments.toolId`. The Tools tab must attribute usage
  // to that inner tool, not the wrapper.
  const ev = parse({
    provider: "anthropic",
    model: "claude-opus-4-8",
    ts: "2026-06-30T12:00:00Z",
    tools: [
      { name: "search_capabilities", description: "d".repeat(120), parameters: { type: "object" } },
      { name: "invoke_tool", description: "d".repeat(120), parameters: { type: "object" } },
      { name: "get_skill_content", description: "d".repeat(120), parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "look up a linear issue" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "s",
            name: "search_capabilities",
            arguments: { query: "linear" },
          },
          {
            type: "tool_call",
            id: "a",
            name: "invoke_tool",
            arguments: { toolId: "linear__get_issue", args: { id: "ABC-1" } },
          },
          {
            type: "tool_call",
            id: "b",
            name: "invoke_tool",
            arguments: { toolId: "linear__get_issue", args: { id: "ABC-2" } },
          },
        ],
      },
    ],
    usage: { input_tokens: 900, output_tokens: 10 },
  });
  const m = categorize(ev);

  // The inner tool shows up with both invoke_tool calls, and no prompt footprint
  // (the gateway never ships the inner tool's schema).
  assert.equal(m.toolsByName["linear__get_issue"].calls, 2);
  assert.equal(m.toolsByName["linear__get_issue"].tokens, 0);
  // The wrapper stays in the map as its own def overhead — it is NOT the inner tool.
  assert.ok(m.toolsByName.invoke_tool, "invoke_tool def kept as gateway overhead");
  assert.equal(m.toolsByName.invoke_tool.calls, 2, "raw invoke_tool call count preserved");

  // Zero-footprint inner tools never perturb the per-tool ↔ split ↔ total invariant.
  const perToolTotal = Object.values(m.toolsByName).reduce((s, t) => s + t.tokens, 0);
  assert.equal(perToolTotal, m.tokensByCategory.tools);
});

test("Ratel gateway: a malformed invoke_tool (no toolId) falls back to the wrapper", () => {
  const ev = parse({
    provider: "anthropic",
    model: "claude-opus-4-8",
    ts: "2026-06-30T12:00:00Z",
    tools: [{ name: "invoke_tool", description: "d".repeat(80), parameters: { type: "object" } }],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "a", name: "invoke_tool", arguments: { args: {} } }],
      },
    ],
    usage: { input_tokens: 300, output_tokens: 5 },
  });
  const m = categorize(ev);
  // No inner id to unwrap → no phantom inner-tool row; the wrapper keeps the call.
  assert.deepEqual(Object.keys(m.toolsByName), ["invoke_tool"]);
  assert.equal(m.toolsByName.invoke_tool.calls, 1);
});

test("without usage, budget falls back to the estimate (all in user_input)", () => {
  const ev = parse({
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    messages: [{ role: "user", content: "Weather in Paris?" }],
  });
  const m = categorize(ev);
  assert.ok(m.tokensByCategory.user_input > 0);
  assert.equal(m.tokensByCategory.history, 0);
  assert.equal(m.tokensByCategory.tools, 0);
  assert.equal(sumCategories(m.tokensByCategory), m.tokensByCategory.user_input);
});
