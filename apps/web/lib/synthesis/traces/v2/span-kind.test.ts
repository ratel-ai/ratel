import assert from "node:assert/strict";
import { test } from "node:test";
import {
  humanSpanName,
  type NamedSpan,
  stepKind,
  stepKindLabel,
  stepTitle,
  toolNameFromSpanName,
} from "./span-kind";

const span = (overrides: Partial<NamedSpan>): NamedSpan => ({
  name: "x",
  spanClass: "other",
  ...overrides,
});

test("span classes and agent operations get the reader's words", () => {
  assert.equal(stepKindLabel(span({ spanClass: "llm_call" })), "Model call");
  assert.equal(stepKindLabel(span({ spanClass: "tool" })), "Tool call");
  assert.equal(stepKindLabel(span({ spanClass: "ratel_search" })), "Search");
  assert.equal(
    stepKindLabel(span({ name: "invoke_agent support-agent", operationName: "invoke_agent" })),
    "Agent step",
  );
  assert.equal(
    stepKindLabel(span({ name: "agent.run", operationName: "agent.run" })),
    "Agent step",
  );
  assert.equal(
    stepKind(span({ name: "planner", attributes: { "gen_ai.agent.name": "planner" } })),
    "agent",
  );
  assert.equal(stepKindLabel(span({ name: "db.query" })), "Step");
  assert.equal(
    stepKind(span({ name: "agentic_cache.lookup" })),
    "step",
    "a word that merely starts with agent is not an agent",
  );
});

test("titles name the model, the tool, the query or the agent", () => {
  assert.equal(stepTitle(span({ spanClass: "llm_call", name: "chat", model: "gpt-5" })), "gpt-5");
  assert.equal(
    stepTitle(span({ spanClass: "llm_call", name: "chat claude-sonnet" })),
    "claude-sonnet",
  );
  assert.equal(
    stepTitle(
      span({
        spanClass: "tool",
        name: "execute_tool lookup_order",
        attributes: { "gen_ai.tool.name": "lookup_order" },
      }),
    ),
    "lookup_order",
  );
  assert.equal(stepTitle(span({ spanClass: "tool", name: "tool.ripgrep" })), "ripgrep");
  assert.equal(
    stepTitle(
      span({
        spanClass: "ratel_search",
        name: "capabilities.search",
        searchQuery: "review a pull request",
      }),
    ),
    "“review a pull request”",
  );
  assert.equal(
    stepTitle(
      span({ spanClass: "ratel_search", name: "capabilities.search", searchTarget: "skills" }),
    ),
    "Searched skills",
  );
  assert.equal(
    stepTitle(
      span({
        name: "invoke_agent support-agent",
        attributes: { "gen_ai.agent.name": "support-agent" },
      }),
    ),
    "support-agent",
  );
  assert.equal(
    stepTitle(span({ name: "db.query" })),
    "db.query",
    "an unknown step keeps its raw name",
  );
});

test("operation prefixes come off span names, nothing else does", () => {
  assert.equal(humanSpanName("invoke_agent support-agent"), "support-agent");
  assert.equal(humanSpanName("agent.run"), "agent.run");
  assert.equal(humanSpanName("chat"), "chat", "an operation alone is the name");
  assert.equal(toolNameFromSpanName("execute_tool search_docs"), "search_docs");
  assert.equal(toolNameFromSpanName("tool."), "tool.");
});
