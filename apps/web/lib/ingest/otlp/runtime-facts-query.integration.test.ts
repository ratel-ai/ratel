import assert from "node:assert/strict";
import { test } from "node:test";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

/** The duplicate check's read against a real schema: SDK invokes only, by session, tool and time. */

const AT = Date.parse("2026-09-30T12:00:00Z");

test("finds the SDK invokes of the probed sessions and tools in the time span, never OTLP rows", async () => {
  const { client, db } = await setupDb();
  const rows: [string, string, string, string, number, string | null][] = [
    ["a1111111-1111-4111-8111-111111111111", "invoke_start", "s-1", "find_task", 0, "runtime"],
    ["a2222222-2222-4222-8222-222222222222", "invoke_end", "s-1", "find_task", 900, null],
    ["a3333333-3333-4333-8333-333333333333", "invoke_end", "s-1", "find_task", 1_000, "otlp"],
    ["a4444444-4444-4444-8444-444444444444", "invoke_end", "s-2", "find_task", 0, "runtime"],
    ["a5555555-5555-4555-8555-555555555555", "invoke_end", "s-1", "assign_task", 0, "runtime"],
    ["a6666666-6666-4666-8666-666666666666", "invoke_end", "s-1", "find_task", 120_000, "runtime"],
  ];
  for (const [id, type, session, tool, offset, source] of rows) {
    const at = new Date(AT + offset).toISOString();
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, tool_id, occurred_at, received_at, client_event_id, ingest_source, payload)
       values ($1, $2, $3, $4, $5, $6, $6, $8, $7, '{}'::jsonb)`,
      [id, PROJECT_ID, type, session, tool, at, source, `c-${id}`],
    );
  }
  const found = await findRuntimeInvokes(
    PROJECT_ID,
    {
      sessionIds: ["s-1"],
      toolIds: ["find_task"],
      from: new Date(AT - 5_000),
      to: new Date(AT + 5_000),
    },
    db,
  );
  assert.deepEqual(
    found
      .map((f) => [f.sessionId, f.toolId, f.at.getTime() - AT])
      .sort((a, b) => Number(a[2]) - Number(b[2])),
    [
      ["s-1", "find_task", 0],
      ["s-1", "find_task", 900],
    ],
  );
});
