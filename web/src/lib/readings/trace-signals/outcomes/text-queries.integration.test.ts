import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  loadNextScopeReplies,
  loadReplies,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

/**
 * The reply reads behind the outcome reading are bounded (not an upstream file: upstream read a
 * call's whole message history and every turn scope a session ever reported). Each read returns
 * what it did before, and the rows Postgres hands back are counted to show what was read.
 */

const BASE = Date.parse("2026-09-10T08:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Every row Postgres returned to a query whose text or parameters match, by query. */
function countRows(client: PGlite, match: RegExp): { rows: unknown[][] } {
  const seen: { rows: unknown[][] } = { rows: [] };
  const query = client.query.bind(client);
  client.query = (async (text: string, params?: unknown[], options?: unknown) => {
    const result = await query(text, params as never, options as never);
    if (match.test(text) || (params ?? []).some((param) => match.test(String(param))))
      seen.rows.push(result.rows as unknown[]);
    return result;
  }) as typeof client.query;
  return seen;
}

async function scope(
  client: PGlite,
  session: string,
  trace: string,
  at: number,
  payload: object = {},
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, payload)
     values ($1::uuid, $2, 'turn_start', $3, $4, $4, $1::text, $5, $6::jsonb)`,
    [id, PROJECT_ID, session, new Date(at).toISOString(), trace, JSON.stringify(payload)],
  );
  return id;
}

async function step(client: PGlite, session: string, trace: string, at: number): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, tool_id, trace_id, payload)
     values ($1::uuid, $2, 'invoke_end', $3, $4, $4, $1::text, 'find_task', $5, '{}'::jsonb)`,
    [id, PROJECT_ID, session, new Date(at).toISOString(), trace],
  );
  return id;
}

async function modelCall(client: PGlite, trace: string, at: number, messages: unknown[]) {
  await client.query(
    `insert into events (project_id, received_at, occurred_at, trace_id, payload) values ($1::uuid, $2::timestamptz, $2::timestamptz, $3, $4::jsonb)`,
    [PROJECT_ID, new Date(at).toISOString(), trace, JSON.stringify({ messages })],
  );
}

const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("a trace's reply is its last call that wrote text, read from each call's last message alone", async () => {
  const { client, db } = await setupDb();
  // A long conversation the input carries along; only each call's own last message is its reply.
  const history = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `earlier message ${i} `.repeat(20),
  }));
  await modelCall(client, "tr-1", BASE, [...history, said("Found it.")]);
  await modelCall(client, "tr-1", BASE + MINUTE, [...history, said("Archived Onboarding v2.")]);
  // A last call that only used a tool keeps the reply before it.
  await modelCall(client, "tr-1", BASE + 2 * MINUTE, [
    ...history,
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
  ]);
  await modelCall(client, "tr-2", BASE, [{ role: "user", content: "hi" }]);
  const read = countRows(client, /"events"/);

  const replies = await loadReplies(PROJECT_ID, ["tr-1", "tr-2", "tr-none"], db);
  assert.deepEqual([...replies], [["tr-1", "Archived Onboarding v2."]]);
  const returned = JSON.stringify(read.rows);
  assert.ok(!returned.includes("earlier message"), "no call's history was read");
  await client.close();
});

test("the next scope's reply is read from the scopes around the turns, not every scope the session reported", async () => {
  const { client, db } = await setupDb();
  // A month of earlier scopes in the same session.
  for (let i = 0; i < 40; i += 1)
    await scope(client, "s-1", `old-${i}`, BASE - 30 * DAY + (i * DAY) / 2);
  await scope(client, "s-1", "tr-a", BASE);
  const a = await step(client, "s-1", "tr-a", BASE + 10_000);
  // The next scope has no call of its own (a "thanks" the agent answered).
  await scope(client, "s-1", "tr-b", BASE + 5 * MINUTE);
  await modelCall(client, "tr-b", BASE + 5 * MINUTE + 5_000, [said("Glad it helped.")]);
  await scope(client, "s-1", "tr-c", BASE + 10 * MINUTE, { user_message: "and the other board?" });
  const c = await step(client, "s-1", "tr-c", BASE + 10 * MINUTE + 10_000);
  const read = countRows(client, /^turn_start$/);

  const replies = await loadNextScopeReplies(
    PROJECT_ID,
    [
      ["turn-a", "s-1", [a]],
      ["turn-c", "s-1", [c]],
    ],
    db,
  );
  // turn-c is its session's last scope: nothing to read, and no fallback pairing for it.
  assert.deepEqual(
    [...replies],
    [
      ["turn-a", "Glad it helped."],
      ["turn-c", ""],
    ],
  );
  const scopesRead = read.rows.reduce((total, rows) => total + rows.length, 0);
  assert.equal(scopesRead, 3, "only the scopes around the turns");
  await client.close();
});
