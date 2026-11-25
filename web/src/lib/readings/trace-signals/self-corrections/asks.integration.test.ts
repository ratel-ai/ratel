import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { loadAsks, opensTurn } from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

/**
 * A trace's ask is its first model call's prompt, but only when that call's
 * captured input ends with a user message. A run the agent opened on its own
 * (a photo arriving, a background step) would otherwise inherit an older
 * message's words and look like the user asking again.
 */

const TRACE = (i: number) => i.toString(16).padStart(32, "0");
const AT = Date.parse("2026-11-20T09:00:00Z");

async function modelCall(
  client: PGlite,
  traceId: string,
  prompt: string,
  input: unknown[] | null,
): Promise<void> {
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, ingest_source, client_event_id, trace_id, payload)
     values ($1, $2, 'otlp_model_call', 's-1', $3, $3, 'otlp', $4, $5, $6::jsonb)`,
    [
      randomUUID(),
      PROJECT_ID,
      new Date(AT).toISOString(),
      `otlp:model:${traceId}`,
      traceId,
      JSON.stringify({ type: "otlp_model_call", prompt }),
    ],
  );
  if (!input) return;
  // The stored messages are the input followed by the model's reply.
  const messages = [...input, { role: "assistant", content: [{ type: "text", text: "Fatto." }] }];
  await client.query(
    `insert into events (id, project_id, received_at, occurred_at, provider, model, payload, dedupe_hash, trace_id)
     values ($1, $2, $3, $3, 'google', 'gemini', $4::jsonb, $5, $6)`,
    [
      randomUUID(),
      PROJECT_ID,
      new Date(AT).toISOString(),
      JSON.stringify({ messages, input_message_count: input.length }),
      `h-${traceId}`,
      traceId,
    ],
  );
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("loadAsks keeps a prompt only when the user opened the trace", async () => {
  const { client, db } = await setupDb();
  const ask = "segna le ore di Marco in cantiere";
  await modelCall(client, TRACE(1), ask, [user(ask)]);
  await modelCall(client, TRACE(2), ask, [user(ask), assistant("Quale cantiere?")]);
  await modelCall(client, TRACE(3), "export the board as pdf", null);

  const asks = await loadAsks(PROJECT_ID, [TRACE(1), TRACE(2), TRACE(3)], db);

  assert.equal(asks.get(TRACE(1)), ask, "a user message opened it");
  assert.equal(
    asks.has(TRACE(2)),
    false,
    "the input ends with the agent's own message: no ask of its own",
  );
  assert.equal(
    asks.get(TRACE(3)),
    "export the board as pdf",
    "no captured input: the prompt stands",
  );
});

test("opensTurn: only a user message, or an unknown one, opens a turn", () => {
  assert.equal(opensTurn("user"), true);
  assert.equal(opensTurn(null), true);
  assert.equal(opensTurn(undefined), true);
  assert.equal(opensTurn("assistant"), false);
  assert.equal(opensTurn("tool"), false);
});
