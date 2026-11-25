import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  addToRange,
  emptyRange,
  type ReplayRange,
  rebuildHandler,
  removeRange,
} from "@/ingest-replay";
import { processLogs } from "@/lib/ingest/otlp/process-logs";
import { processTraces } from "@/lib/ingest/otlp/process-traces";
import type { Envelope } from "@/lib/ingest/queue/envelope";
import type { EnvelopeHandler } from "@/lib/ingest/queue/port/envelope-queue";
import { createEnvelopeHandler } from "@/lib/ingest/queue/process";
import {
  type Deployment,
  dumpTables,
  envelopeHandler,
  ingestEvents,
  ingestLogs,
  ingestTraces,
  processEventsDeps,
  processLogsDeps,
  processTracesDeps,
  setupDeployment,
  usageOf,
} from "@/lib/ingest/queue/test-support";
import { processEvents } from "@/lib/ingest/trace-events/process-events";

const json = (value: unknown) => ({
  contentType: "application/json",
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

function chatSpan(traceId: string, spanId: string, input: number) {
  const at = (ms: number) => String((Date.now() - 60_000 + ms) * 1_000_000);
  return {
    traceId,
    spanId,
    name: "chat",
    kind: 3,
    startTimeUnixNano: at(0),
    endTimeUnixNano: at(500),
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-5.1" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: String(input) } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } },
      {
        key: "gen_ai.input.messages",
        value: {
          stringValue: JSON.stringify([
            { role: "user", parts: [{ type: "text", content: `ask ${spanId}` }] },
          ]),
        },
      },
    ],
  };
}

const traces = (...spans: unknown[]) =>
  json({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] });

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);

function runtimeEvent(type: string, over: Record<string, unknown> = {}) {
  return {
    v: 2,
    type,
    ts: Date.now() - 60_000,
    session_id: "s1",
    event_id: randomUUID(),
    source_id: "src",
    ...over,
  };
}

/** A deployment that took telemetry of all three signals, and the envelopes it took. */
async function ingested(): Promise<{ deployment: Deployment; envelopes: Envelope[] }> {
  const deployment = await setupDeployment();
  const envelopes: Envelope[] = [];
  const queue = { publish: async (envelope: Envelope) => void envelopes.push(envelope) };
  await ingestTraces(
    deployment,
    [traces(chatSpan(TRACE_A, "a".repeat(16), 10)), traces(chatSpan(TRACE_B, "b".repeat(16), 20))],
    queue,
  );
  await ingestLogs(
    deployment,
    [
      json({
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: String((Date.now() - 60_000) * 1_000_000),
                    eventName: "ratel.search",
                    traceId: TRACE_A,
                    spanId: "a".repeat(16),
                    body: { stringValue: "hello" },
                    attributes: [{ key: "event.name", value: { stringValue: "ratel.search" } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ],
    queue,
  );
  await ingestEvents(
    deployment,
    [
      json({
        events: [
          runtimeEvent("invoke_end", { tool_id: "tool", took_ms: 7, invocation_id: "i1" }),
          runtimeEvent("invoke_error", {
            tool_id: "tool",
            took_ms: 3,
            invocation_id: "i2",
            error: "x",
          }),
        ],
      }),
    ],
    queue,
  );
  const handler = envelopeHandler(deployment);
  await deliver(handler, envelopes);
  return { deployment, envelopes };
}

async function deliver(handler: EnvelopeHandler, envelopes: Envelope[]): Promise<void> {
  for (const envelope of envelopes) {
    const result = await handler(envelope, { attempt: 1 } as never);
    assert.equal(result.outcome, "ack", JSON.stringify(result));
  }
}

/** As `configuredHandler` makes it for a replay: no counter, no key stamp. */
function replayHandler(deployment: Deployment): EnvelopeHandler {
  const quiet = { touchApiKeyAt: async () => ({ first: false }) };
  return createEnvelopeHandler({
    findProject: async () => ({
      organization: { id: "22222222-2222-4222-8222-222222222222" } as never,
    }),
    traces: (envelope, context) =>
      processTraces(
        envelope,
        context,
        processTracesDeps(deployment, { ...quiet, incrementEventUsage: undefined }),
      ),
    logs: (envelope, context) => processLogs(envelope, context, processLogsDeps(deployment, quiet)),
    events: (envelope, context) =>
      processEvents(envelope, context, processEventsDeps(deployment, quiet)),
  });
}

/** The jobs queue is not telemetry: a replay queues builds, as ingest did. */
async function stored(deployment: Deployment) {
  const { jobs: _jobs, ...tables } = await dumpTables(deployment, {
    keep: ["api_keys.last_used_at"],
  });
  return tables;
}

async function rebuild(
  deployment: Deployment,
  envelopes: Envelope[],
  isMargin = (_: Envelope) => false,
) {
  const range: ReplayRange = emptyRange();
  for (const envelope of envelopes) if (!isMargin(envelope)) addToRange(range, envelope);
  await removeRange(deployment.db, range);
  await deliver(rebuildHandler(replayHandler(deployment), range, isMargin), envelopes);
}

test("FILL restores rows deleted by hand, leaves the others unchanged and counts nothing", async () => {
  const { deployment, envelopes } = await ingested();
  const before = await stored(deployment);
  const usage = await usageOf(deployment);
  assert.ok(usage > 0 && before.otel_spans.length === 2 && before.otel_logs.length === 1);
  await deployment.client.exec(`
    delete from otel_spans where trace_id = '${TRACE_A}';
    delete from events where trace_id = '${TRACE_A}';
    delete from otel_logs;
    update otel_spans set name = 'changed by hand' where trace_id = '${TRACE_B}'`);
  await deliver(replayHandler(deployment), envelopes);
  const { rows } = await deployment.client.query<{ name: string }>(
    `select name from otel_spans where trace_id = '${TRACE_B}'`,
  );
  assert.deepEqual(rows, [{ name: "changed by hand" }], "a row that is there is left alone");
  await deployment.client.exec(`update otel_spans set name = 'chat' where trace_id = '${TRACE_B}'`);
  assert.deepEqual(await stored(deployment), before);
  assert.equal(await usageOf(deployment), usage);
});

test("REBUILD removes what an old parser stored and stores the range again, counters as before", async () => {
  const { deployment, envelopes } = await ingested();
  const before = await stored(deployment);
  const usage = await usageOf(deployment);
  assert.equal(before.tool_usage_counters.length, 1);
  // As a wrong parser would have: other values, and a row that today's parser does not make.
  await deployment.client.exec(`
    update events set input_tokens = 999;
    update otel_spans set name = 'wrong';
    update otel_logs set body = '"wrong"';
    insert into trace_events (id, project_id, type, schema_version, session_id, occurred_at, ingest_source, trace_id, client_event_id, payload)
      select gen_random_uuid(), project_id, 'search', 1, 's', now(), 'otlp', '${TRACE_A}', 'bogus', '{}' from events limit 1`);
  await rebuild(deployment, envelopes);
  assert.deepEqual(await stored(deployment), before);
  assert.equal(await usageOf(deployment), usage);
});

test("REBUILD of a range leaves other traces alone, and makes a trace that began before it whole", async () => {
  const { deployment, envelopes } = await ingested();
  const [a, b] = envelopes;
  // The same trace A, one more envelope inside the range.
  const more: Envelope[] = [];
  await ingestTraces(deployment, [traces(chatSpan(TRACE_A, "c".repeat(16), 30))], {
    publish: async (envelope) => void more.push(envelope),
  });
  await deliver(envelopeHandler(deployment), more);
  const before = await stored(deployment);
  await deployment.client.exec(`update otel_spans set name = 'kept' where trace_id = '${TRACE_B}'`);
  await rebuild(deployment, [a, b, ...more], (envelope) => envelope.id !== more[0].id);
  const { rows } = await deployment.client.query<{ trace_id: string; name: string }>(
    "select trace_id, name from otel_spans order by span_id",
  );
  assert.deepEqual(rows, [
    { trace_id: TRACE_A, name: "chat" },
    { trace_id: TRACE_B, name: "kept" },
    { trace_id: TRACE_A, name: "chat" },
  ]);
  await deployment.client.exec(`update otel_spans set name = 'chat'`);
  assert.deepEqual(await stored(deployment), before);
});
