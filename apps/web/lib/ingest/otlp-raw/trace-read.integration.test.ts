import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createOtlpRawStore, type OtlpRawStoreDb } from "./store";
import { readTraceRawSpans, type TraceRawReadDb } from "./trace-read";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const OTHER_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const NOW = new Date("2026-11-09T12:00:00.000Z");

test("a trace split across two stored exports returns all its spans with full attributes", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  await storeSpans(store, PROJECT_ID, [
    span(TRACE_ID, "00f067aa0ba902b7", null, "invoke_agent", 1_000, {
      "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
    }),
    span(OTHER_TRACE_ID, "1111111111111111", null, "other run", 1_000, {}),
  ]);
  await storeSpans(store, PROJECT_ID, [
    span(TRACE_ID, "b7ad6b7169203331", "00f067aa0ba902b7", "execute_tool search", 1_500, {
      "gen_ai.tool.call.arguments": '{"q":"weather"}',
      "gen_ai.tool.call.result": '{"temp":21}',
      "vendor.custom.key": "kept",
    }),
  ]);

  const result = await readTraceRawSpans(db, { projectId: PROJECT_ID, traceId: TRACE_ID });

  assert.equal(result.exports, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.spans.map((s) => s.name),
    ["invoke_agent", "execute_tool search"],
  );
  const tool = result.spans[1];
  assert.equal(tool.parentSpanId, "00f067aa0ba902b7");
  assert.deepEqual(tool.attributes, {
    "gen_ai.tool.call.arguments": '{"q":"weather"}',
    "gen_ai.tool.call.result": '{"temp":21}',
    "vendor.custom.key": "kept",
  });
  assert.deepEqual(tool.resourceAttributes, { "service.name": "agent" });
  assert.deepEqual(tool.events, [{ name: "tick", timeUnixMs: 1_500, attributes: { n: 1 } }]);
  assert.equal(tool.scopeName, "test-scope");
});

test("a span exported twice is returned once", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  const root = span(TRACE_ID, "00f067aa0ba902b7", null, "invoke_agent", 1_000, {});
  await storeSpans(store, PROJECT_ID, [root]);
  await storeSpans(store, PROJECT_ID, [root]);

  const result = await readTraceRawSpans(db, { projectId: PROJECT_ID, traceId: TRACE_ID });

  assert.equal(result.spans.length, 1);
});

test("a project with raw capture off returns an empty result, not an error", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  await storeSpans(store, OTHER_PROJECT_ID, [
    span(TRACE_ID, "00f067aa0ba902b7", null, "elsewhere", 1_000, {}),
  ]);

  const result = await readTraceRawSpans(db, { projectId: PROJECT_ID, traceId: TRACE_ID });

  assert.deepEqual(result, { spans: [], exports: 0, undecodable: 0, truncated: false });
});

test("a trace id that two projects share returns only the asking project's spans", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  await storeSpans(store, OTHER_PROJECT_ID, [
    span(TRACE_ID, "00000000000000b1", null, "theirs", 1_000, {}),
  ]);
  await storeSpans(store, PROJECT_ID, [
    span(TRACE_ID, "00000000000000a1", null, "mine", 1_000, {}),
  ]);

  const result = await readTraceRawSpans(db, { projectId: PROJECT_ID, traceId: TRACE_ID });

  assert.equal(result.exports, 1);
  assert.deepEqual(
    result.spans.map((s) => s.name),
    ["mine"],
  );
});

test("the read stops at the row and byte bounds and says it was truncated", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  for (const [index, id] of [
    "00000000000000a1",
    "00000000000000a2",
    "00000000000000a3",
  ].entries()) {
    await storeSpans(store, PROJECT_ID, [
      span(TRACE_ID, id, null, `span ${index}`, 1_000 + index, {}),
    ]);
  }

  const byRows = await readTraceRawSpans(db, {
    projectId: PROJECT_ID,
    traceId: TRACE_ID,
    maxExports: 2,
  });
  const byBytes = await readTraceRawSpans(db, {
    projectId: PROJECT_ID,
    traceId: TRACE_ID,
    maxBytes: 1,
  });

  assert.deepEqual([byRows.exports, byRows.spans.length, byRows.truncated], [2, 2, true]);
  assert.deepEqual([byBytes.exports, byBytes.spans.length, byBytes.truncated], [1, 1, true]);
});

test("an undecodable body is counted and skipped", async () => {
  const db = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  await store.store({
    projectId: PROJECT_ID,
    signal: "traces",
    contentType: "application/json",
    body: new TextEncoder().encode("not json"),
    itemCount: 1,
    traceIds: [TRACE_ID],
  });
  await storeSpans(store, PROJECT_ID, [
    span(TRACE_ID, "00f067aa0ba902b7", null, "invoke_agent", 1_000, {}),
  ]);

  const result = await readTraceRawSpans(db, {
    projectId: PROJECT_ID,
    traceId: TRACE_ID.toUpperCase(),
  });

  assert.deepEqual([result.exports, result.undecodable, result.spans.length], [2, 1, 1]);
});

interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  events: Array<{
    name: string;
    timeUnixNano: string;
    attributes: Array<{ key: string; value: { intValue: string } }>;
  }>;
}

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  name: string,
  startMs: number,
  attributes: Record<string, string>,
): JsonSpan {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startTimeUnixNano: `${startMs}000000`,
    endTimeUnixNano: `${startMs + 100}000000`,
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    })),
    events: [
      {
        name: "tick",
        timeUnixNano: `${startMs}000000`,
        attributes: [{ key: "n", value: { intValue: "1" } }],
      },
    ],
  };
}

async function storeSpans(
  store: ReturnType<typeof createOtlpRawStore>,
  projectId: string,
  spans: JsonSpan[],
): Promise<void> {
  const request = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
        scopeSpans: [{ scope: { name: "test-scope" }, spans }],
      },
    ],
  };
  await store.store({
    projectId,
    signal: "traces",
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(request)),
    itemCount: spans.length,
    traceIds: [...new Set(spans.map((s) => s.traceId))],
  });
}

async function setup(): Promise<TraceRawReadDb & OtlpRawStoreDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return drizzle(client, { schema }) as never;
}
