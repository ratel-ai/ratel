import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { ReplayDb } from "@/lib/views/session-replay/load";
import { readSessionReplaySource } from "../pg-session-source";
import { matchSandbox } from "../session-source";

/**
 * The replay source of a recorded session against real PGlite, with synthetic
 * spans: the session's closed turns in order, each turn's user message (from
 * its first model call's payload) and its `execute_tool` calls with results.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const SESSION = "docs-session-1";
const TRACE_1 = "1".repeat(32);
const TRACE_2 = "2".repeat(32);

async function setup(): Promise<{ client: PGlite; db: ReplayDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReplayDb };
}

interface SpanRow {
  traceId: string;
  spanId: string;
  parent?: string | null;
  at: string;
  operation: string;
  status?: number;
  attributes?: Record<string, unknown>;
}

async function span(client: PGlite, row: SpanRow): Promise<void> {
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, operation_name, attributes)
     values ($1, $2, $3, $4, $5, $6, 1, 'other', $7, $7, 1, $8, $9, $10)`,
    [
      randomUUID(),
      PROJ,
      row.traceId,
      row.spanId,
      row.parent ?? null,
      row.operation,
      row.at,
      row.status ?? 0,
      row.operation,
      JSON.stringify(row.attributes ?? {}),
    ],
  );
}

async function turn(client: PGlite, traceId: string, at: string, status = "closed"): Promise<void> {
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at) values ($1, $2, $3, $4, 'otlp', 'otlp', $5, $6, $6, $6)`,
    [randomUUID(), PROJ, SESSION, `otlp:${traceId}`, status, at],
  );
}

async function modelCall(
  client: PGlite,
  traceId: string,
  spanId: string,
  messages: unknown[],
): Promise<void> {
  const payload = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    ts: "2026-11-19T10:00:00Z",
    messages,
    input_message_count: messages.length,
  };
  await client.query(
    `insert into events (project_id, trace_id, span_id, payload) values ($1, $2, $3, $4)`,
    [PROJ, traceId, spanId, JSON.stringify(payload)],
  );
}

/** Two turns of a docs-agent session: the second has two tool calls, one inside a framework span. */
async function seedSession(
  client: PGlite,
  { withContent }: { withContent: boolean },
): Promise<void> {
  const root = { "gen_ai.agent.name": "docs-agent", "gen_ai.conversation.id": SESSION };
  // Turn 2 is stored first: the order comes from the turns' start, not from insert order.
  await turn(client, TRACE_2, "2026-11-19T10:05:00Z");
  await turn(client, TRACE_1, "2026-11-19T10:00:00Z");
  await span(client, {
    traceId: TRACE_1,
    spanId: "1000000000000001",
    at: "2026-11-19T10:00:00Z",
    operation: "invoke_agent",
    attributes: { ...root, "ratel.sandbox.id": "docs-agent-sandbox" },
  });
  await span(client, {
    traceId: TRACE_1,
    spanId: "1000000000000002",
    parent: "1000000000000001",
    at: "2026-11-19T10:00:01Z",
    operation: "chat",
  });
  await span(client, {
    traceId: TRACE_1,
    spanId: "1000000000000003",
    parent: "1000000000000001",
    at: "2026-11-19T10:00:02Z",
    operation: "execute_tool",
    attributes: {
      "gen_ai.tool.name": "searchDocs",
      "gen_ai.tool.call.arguments": '{"query":"keys","limit":3}',
      "gen_ai.tool.call.result": '{"hits":["api-keys"]}',
    },
  });
  await span(client, {
    traceId: TRACE_2,
    spanId: "2000000000000001",
    at: "2026-11-19T10:05:00Z",
    operation: "invoke_agent",
    attributes: root,
  });
  await span(client, {
    traceId: TRACE_2,
    spanId: "2000000000000002",
    parent: "2000000000000001",
    at: "2026-11-19T10:05:01Z",
    operation: "chat",
  });
  await span(client, {
    traceId: TRACE_2,
    spanId: "2000000000000004",
    parent: "2000000000000001",
    at: "2026-11-19T10:05:03Z",
    operation: "execute_tool",
    status: 2,
    attributes: {
      "gen_ai.tool.name": "createTicket",
      "gen_ai.tool.call.arguments": '{"title":"Rotate key"}',
      "gen_ai.tool.call.result": '{"error":"quota"}',
    },
  });
  await span(client, {
    traceId: TRACE_2,
    spanId: "2000000000000003",
    parent: "2000000000000001",
    at: "2026-11-19T10:05:02Z",
    operation: "execute_tool",
    attributes: {
      "gen_ai.tool.name": "readDoc",
      "gen_ai.tool.call.arguments": '{"slug":"api-keys"}',
      "gen_ai.tool.call.result": '"# API keys"',
    },
  });
  // The runner's span of the same readDoc call, inside the framework span: not a second call.
  await span(client, {
    traceId: TRACE_2,
    spanId: "2000000000000005",
    parent: "2000000000000003",
    at: "2026-11-19T10:05:02Z",
    operation: "execute_tool",
    attributes: {
      "gen_ai.tool.name": "readDoc",
      "gen_ai.tool.call.arguments": '{"slug":"api-keys"}',
      "gen_ai.tool.call.result": '"# API keys"',
    },
  });
  if (withContent) {
    await modelCall(client, TRACE_1, "1000000000000002", [
      { role: "user", content: "How do I make an API key?" },
    ]);
    await modelCall(client, TRACE_2, "2000000000000002", [
      { role: "user", content: "How do I make an API key?" },
      { role: "assistant", content: "Open Settings." },
      { role: "user", content: [{ type: "text", text: "And how do I rotate it?" }] },
    ]);
  } else {
    // Traces without message content: the model calls store no messages.
    await modelCall(client, TRACE_1, "1000000000000002", []);
    await modelCall(client, TRACE_2, "2000000000000002", []);
  }
}

test("a session with content yields its user messages in order and its recorded tool calls", async () => {
  const { client, db } = await setup();
  try {
    await seedSession(client, { withContent: true });
    const source = await readSessionReplaySource(db, {
      projectId: PROJ,
      sessionId: SESSION,
      readContent: true,
    });
    assert.equal(source.replayable, true);
    if (!source.replayable) return;
    assert.deepEqual(
      source.turns.map((t) => ({ traceId: t.traceId, userMessage: t.userMessage })),
      [
        { traceId: TRACE_1, userMessage: "How do I make an API key?" },
        { traceId: TRACE_2, userMessage: "And how do I rotate it?" },
      ],
    );
    assert.deepEqual(source.turns[0]!.toolCalls, [
      {
        tool: "searchDocs",
        args: { query: "keys", limit: 3 },
        result: { hits: ["api-keys"] },
        isError: false,
      },
    ]);
    assert.deepEqual(source.turns[1]!.toolCalls, [
      { tool: "readDoc", args: { slug: "api-keys" }, result: "# API keys", isError: false },
      {
        tool: "createTicket",
        args: { title: "Rotate key" },
        result: { error: "quota" },
        isError: true,
      },
    ]);
    assert.equal(source.sandboxId, "docs-agent-sandbox");
    assert.equal(source.agentName, "docs-agent");
  } finally {
    await client.close();
  }
});

test("a session without message content is not replayable, with the reason", async () => {
  const { client, db } = await setup();
  try {
    await seedSession(client, { withContent: false });
    const source = await readSessionReplaySource(db, {
      projectId: PROJ,
      sessionId: SESSION,
      readContent: true,
    });
    assert.equal(source.replayable, false);
    if (source.replayable) return;
    assert.equal(source.reason, "no_message_content");
    assert.match(source.message, /without message content/);
  } finally {
    await client.close();
  }
});

test("with the project's content opt-in off, the session is not replayable and no text is read", async () => {
  const { client, db } = await setup();
  try {
    await seedSession(client, { withContent: true });
    const source = await readSessionReplaySource(db, {
      projectId: PROJ,
      sessionId: SESSION,
      readContent: false,
    });
    assert.deepEqual(source.replayable ? null : source.reason, "content_off");
  } finally {
    await client.close();
  }
});

test("an unknown session, or one with only open turns, is not replayable", async () => {
  const { client, db } = await setup();
  try {
    await turn(client, TRACE_1, "2026-11-19T10:00:00Z", "open");
    await span(client, {
      traceId: TRACE_1,
      spanId: "1000000000000001",
      at: "2026-11-19T10:00:00Z",
      operation: "invoke_agent",
    });
    const source = await readSessionReplaySource(db, {
      projectId: PROJ,
      sessionId: SESSION,
      readContent: true,
    });
    assert.deepEqual(source.replayable ? null : source.reason, "no_session");
  } finally {
    await client.close();
  }
});

test("the sandbox of a stored session: by ratel.sandbox.id first, then by agent name", async () => {
  const { client, db } = await setup();
  try {
    await seedSession(client, { withContent: true });
    const source = await readSessionReplaySource(db, {
      projectId: PROJ,
      sessionId: SESSION,
      readContent: true,
    });
    assert.ok(source.replayable);
    assert.deepEqual(matchSandbox(source, ["docs-agent", "docs-agent-sandbox"]), {
      sandboxId: "docs-agent-sandbox",
      by: "sandbox_id",
    });
    assert.deepEqual(matchSandbox(source, ["docs-agent"]), {
      sandboxId: "docs-agent",
      by: "agent_name",
    });
  } finally {
    await client.close();
  }
});
