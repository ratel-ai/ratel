import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_RUN_EVENT_TYPE, deriveAgentRuns } from "./derive-agent-runs";
import type { DecodedSpan } from "./types";

/**
 * RC-742: an `invoke_agent` root span (Ratel Cloud's own backend jobs, RC-722)
 * is one agent run: one `agent_run` ledger row that carries the run's ask, so
 * a run of `chat` spans with no tool span still makes a turn.
 */

const ASK = JSON.stringify([
  { role: "user", parts: [{ type: "text", content: "label_workflows for project p-1" }] },
]);
const PROMPT = JSON.stringify([
  { role: "user", parts: [{ type: "text", content: "Name this workflow" }] },
]);
const T0 = Date.parse("2026-11-17T10:00:00Z");

function span(overrides: Partial<DecodedSpan>): DecodedSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "1".repeat(16),
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: T0,
    endUnixMs: T0 + 4_000,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "ratel-cloud" },
    scopeName: "ratel-cloud/model-calls",
    ...overrides,
  };
}

const root = (overrides: Partial<DecodedSpan> = {}) =>
  span({
    name: "invoke_agent label_workflows",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "label_workflows",
      "gen_ai.conversation.id": "job-1",
      "gen_ai.input.messages": ASK,
    },
    ...overrides,
  });

const chat = (overrides: Partial<DecodedSpan> = {}) =>
  span({
    spanId: "2".repeat(16),
    parentSpanId: "1".repeat(16),
    name: "chat claude-sonnet-5-5",
    kind: 3,
    startUnixMs: T0 + 100,
    endUnixMs: T0 + 3_900,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.input.messages": PROMPT,
    },
    ...overrides,
  });

test("an invoke_agent root is one agent_run row with the root's ask, agent and session", () => {
  const rows = deriveAgentRuns([root(), chat()]);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.type, AGENT_RUN_EVENT_TYPE);
  assert.equal(row.ingestSource, "otlp");
  assert.equal(row.traceId, "a".repeat(32));
  assert.equal(row.spanId, "1".repeat(16));
  assert.equal(row.sessionId, "job-1");
  assert.equal(row.sourceId, "ratel-cloud");
  assert.equal(row.toolId, null);
  assert.equal(row.tookMs, 4_000);
  assert.equal(row.occurredAt?.getTime(), T0);
  assert.equal(row.clientEventId, `otlp:agent:${"a".repeat(32)}:${"1".repeat(16)}`);
  assert.equal(row.payload.prompt, "label_workflows for project p-1");
  assert.equal(row.payload.agent, "label_workflows");
  assert.equal(row.errorMessage, null);
});

test("the root arrives alone (its chat children came in an earlier export): still one row", () => {
  assert.equal(deriveAgentRuns([root()]).length, 1);
});

test("a failed run carries its error type", () => {
  const [row] = deriveAgentRuns([
    root({ statusCode: 2, attributes: { ...root().attributes, "error.type": "TimeoutError" } }),
  ]);
  assert.equal(row?.errorMessage, "TimeoutError");
});

test("a run without an ask or a conversation id: no prompt, session is the trace", () => {
  const [row] = deriveAgentRuns([
    root({
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "label_workflows",
      },
    }),
  ]);
  assert.equal(row?.payload.prompt, undefined);
  assert.equal(row?.sessionId, "a".repeat(32));
});

test("bare chat spans, a nested invoke_agent and non-agent roots make no row", () => {
  assert.deepEqual(deriveAgentRuns([chat({ parentSpanId: null })]), []);
  assert.deepEqual(deriveAgentRuns([root({ parentSpanId: "9".repeat(16) })]), []);
  assert.deepEqual(deriveAgentRuns([span({ name: "GET /api", attributes: {} })]), []);
});
