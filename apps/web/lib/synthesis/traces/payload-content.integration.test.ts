import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listCapturedAsks, loadPayloadContent, type PayloadDb } from "./payload-content";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");

test("a trace's events.payload messages load as its content, and another project's never do", async () => {
  const { client, db } = await setup();
  await db.insert(events).values([
    event(PROJECT_ID, traceId(1), 1, {
      system: "You are the Site Copilot.",
      messages: [
        { role: "user", content: "Where is order 1234?" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: "1234" } },
          ],
        },
      ],
      input_message_count: 1,
    }),
    event(PROJECT_ID, traceId(1), 2, {
      messages: [
        { role: "user", content: "Where is order 1234?" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: "1234" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' },
        { role: "assistant", content: "It shipped yesterday." },
      ],
      input_message_count: 3,
    }),
    event(OTHER_PROJECT_ID, traceId(1), 3, {
      messages: [{ role: "user", content: "another tenant's secret" }],
    }),
  ]);

  const content = await loadPayloadContent(PROJECT_ID, traceId(1), db);
  assert.ok(content);
  assert.equal(content.view.contentCaptured, true);
  assert.equal(content.ask, "Where is order 1234?");
  assert.ok(content.view.messages.some((message) => message.text === "It shipped yesterday."));
  assert.ok(!content.view.messages.some((message) => message.text.includes("secret")));
  assert.deepEqual(
    content.view.toolCalls.map(({ name, arguments: args, result }) => ({ name, args, result })),
    [{ name: "lookup_order", args: { id: "1234" }, result: { status: "shipped" } }],
  );
  await client.close();
});

test("a trace with no payload text still has its ask from trace_events, and one with neither has nothing", async () => {
  const { client, db } = await setup();
  await db.insert(events).values(event(PROJECT_ID, traceId(2), 1, { messages: [] }));
  await db
    .insert(traceEvents)
    .values([
      traceEvent(traceId(2), 2, "the later prompt"),
      traceEvent(traceId(2), 1, "Summarize the ticket"),
    ]);

  const content = await loadPayloadContent(PROJECT_ID, traceId(2), db);
  assert.deepEqual(content, {
    view: { messages: [], toolCalls: [], contentCaptured: false },
    ask: "Summarize the ticket",
  });
  assert.equal(await loadPayloadContent(PROJECT_ID, traceId(9), db), null);
  await client.close();
});

test("the runs list gets each run's ask from its payload, else from trace_events", async () => {
  const { client, db } = await setup();
  await db.insert(events).values([
    event(PROJECT_ID, traceId(1), 2, { messages: [{ role: "user", content: "a follow-up" }] }),
    event(PROJECT_ID, traceId(1), 1, {
      messages: [{ role: "user", content: [{ type: "text", text: "the first question" }] }],
    }),
    event(OTHER_PROJECT_ID, traceId(3), 1, {
      messages: [{ role: "user", content: "not this project's" }],
    }),
  ]);
  await db
    .insert(traceEvents)
    .values([
      traceEvent(traceId(1), 1, "the derived prompt"),
      traceEvent(traceId(2), 1, "only derived"),
    ]);

  const asks = await listCapturedAsks(PROJECT_ID, [traceId(1), traceId(2), traceId(3)], db);
  assert.deepEqual([...asks.entries()].sort(), [
    [traceId(1), "the first question"],
    [traceId(2), "only derived"],
  ]);
  assert.equal((await listCapturedAsks(PROJECT_ID, [], db)).size, 0);
  await client.close();
});

async function setup(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: PayloadDb & { insert: ReturnType<typeof drizzle>["insert"] };
}> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return { client, db: drizzle(client, { schema }) as never };
}

function event(
  projectId: string,
  trace: string,
  second: number,
  payload: Partial<CloudEvent> & Pick<CloudEvent, "messages">,
): typeof events.$inferInsert {
  const at = new Date(T0 + second * 1000);
  return {
    projectId,
    occurredAt: at,
    traceId: trace,
    spanId: `${trace.slice(0, 14)}${String(second).padStart(2, "0")}`,
    latencyMs: 900,
    dedupeHash: `${projectId}:${trace}:${second}`,
    payload: { provider: "openai", model: "gpt-5", ts: at.toISOString(), ...payload },
  };
}

function traceEvent(
  trace: string,
  second: number,
  prompt: string,
): typeof traceEvents.$inferInsert {
  return {
    id: `44444444-4444-4444-8444-${trace.slice(-6)}${String(second).padStart(6, "0")}`,
    projectId: PROJECT_ID,
    type: OTLP_MODEL_CALL,
    clientEventId: `otlp:model:${trace}:${second}`,
    traceId: trace,
    occurredAt: new Date(T0 + second * 1000),
    payload: { type: OTLP_MODEL_CALL, derived_from: "otlp", prompt },
  };
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}
