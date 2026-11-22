import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplaySource, matchSandbox, type SourceSpan, turnPath } from "../session-source";

/** The pure rules of the session replay source: sandbox match, the recorded path, and the not-replayable reasons. */

const recorded = [
  { tool: "searchDocs", args: { query: "keys", limit: 3 } },
  { tool: "readDoc", args: { slug: "api-keys" } },
];

test("matchSandbox prefers ratel.sandbox.id, falls back to the agent name, else null", () => {
  assert.deepEqual(matchSandbox({ sandboxId: "a", agentName: "b" }, ["a", "b"]), {
    sandboxId: "a",
    by: "sandbox_id",
  });
  assert.deepEqual(matchSandbox({ sandboxId: "gone", agentName: "b" }, ["a", "b"]), {
    sandboxId: "b",
    by: "agent_name",
  });
  assert.deepEqual(matchSandbox({ sandboxId: null, agentName: "b" }, ["b"]), {
    sandboxId: "b",
    by: "agent_name",
  });
  assert.equal(matchSandbox({ sandboxId: "x", agentName: "y" }, ["a"]), null);
  assert.equal(matchSandbox({ sandboxId: null, agentName: null }, ["a"]), null);
});

test("turnPath: the same calls, or a prefix of them, stay on the recorded path", () => {
  assert.deepEqual(turnPath(recorded, recorded), { diverged: false, firstOffPath: null });
  assert.deepEqual(turnPath(recorded, recorded.slice(0, 1)), {
    diverged: false,
    firstOffPath: null,
  });
  assert.deepEqual(turnPath(recorded, []), { diverged: false, firstOffPath: null });
});

test("turnPath: arguments compare normalized (key order, JSON text)", () => {
  assert.equal(
    turnPath(recorded, [{ tool: "searchDocs", args: { limit: 3, query: "keys" } }]).diverged,
    false,
  );
  assert.equal(
    turnPath(recorded, [{ tool: "searchDocs", args: '{"limit":3,"query":"keys"}' }]).diverged,
    false,
  );
});

test("turnPath: a call outside the recorded path diverges at its place", () => {
  assert.deepEqual(
    turnPath(recorded, [recorded[0]!, { tool: "createTicket", args: { title: "x" } }]),
    { diverged: true, firstOffPath: 1 },
  );
  assert.deepEqual(
    turnPath(recorded, [{ tool: "searchDocs", args: { query: "rotate", limit: 3 } }]),
    { diverged: true, firstOffPath: 0 },
  );
  assert.deepEqual(turnPath(recorded, [...recorded, { tool: "readDoc", args: { slug: "more" } }]), {
    diverged: true,
    firstOffPath: 2,
  });
  assert.deepEqual(turnPath([], [{ tool: "searchDocs", args: {} }]), {
    diverged: true,
    firstOffPath: 0,
  });
});

test("buildReplaySource skips a turn with no ask, and is not replayable when none has one", () => {
  const span = (spanId: string, at: number): SourceSpan => ({
    spanId,
    parentSpanId: null,
    startedAt: new Date(at),
    operation: "chat",
    statusCode: 0,
    attributes: {},
  });
  const ask = (text: string) => ({
    provider: "p",
    model: "m",
    ts: "",
    messages: [{ role: "user" as const, content: text }],
  });
  const turns = [
    { traceIds: ["t1"], spans: [span("a", 1)], payloads: new Map([["a", ask("first")]]) },
    { traceIds: ["t2"], spans: [span("b", 2)], payloads: new Map() },
    { traceIds: ["t3"], spans: [span("c", 3)], payloads: new Map([["c", ask("  ")]]) },
  ];
  const source = buildReplaySource("s", turns, { readContent: true });
  assert.ok(source.replayable);
  assert.deepEqual(
    source.turns.map((t) => [t.turnIndex, t.traceId, t.userMessage]),
    [[0, "t1", "first"]],
  );
  const none = buildReplaySource("s", turns.slice(1), { readContent: true });
  assert.deepEqual(none.replayable ? null : none.reason, "no_message_content");
  const empty = buildReplaySource("s", [], { readContent: true });
  assert.deepEqual(empty.replayable ? null : empty.reason, "no_session");
});
