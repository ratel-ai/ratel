import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { DeliveryStatus, RuntimeEventsPublisher } from "@ratel-ai/cloud-sdk/runtime";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { handleRuntimeEventsRequest } from "@/lib/ingest/trace-events/route-handler";
import { enqueueIngestBatch } from "./queries";
import {
  drainLane,
  dumpTables,
  eventsRouteDeps,
  SECRET_KEY,
  setupDeployment,
  tracesRouteDeps,
} from "./test-support";

/**
 * The released SDK against both answers (ADR-0009, ADR-0010): the routes' with their queue on, and what
 * a gateway says. Neither makes it send again or count a reject.
 */

type Answer = (request: Request) => Promise<Response>;

/** Answers as a gateway: 202, and for events every one of the batch accepted. */
const gateway: Answer = async (request) => {
  if (request.url.endsWith("/v1/traces")) return Response.json({}, { status: 202 });
  const { events } = (await request.json()) as { events: unknown[] };
  return Response.json({ accepted: events.length, duplicates: 0, rejected: [] }, { status: 202 });
};

async function serve(answer: Answer) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(req.url ?? "");
    const response = await answer(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function sendEvents(url: string) {
  const rejected: unknown[] = [];
  const status = new DeliveryStatus({ warnOnFailure: false });
  const publisher = new RuntimeEventsPublisher({
    apiKey: SECRET_KEY,
    baseUrl: url,
    deliveryStatus: status,
    onRejected: (list) => rejected.push(...list),
  });
  for (const id of ["a", "b"]) {
    publisher.publish({
      v: 2,
      event_id: `sdk-${id}`,
      ts: Date.now(),
      session_id: "session-1",
      source_id: "worker-a",
      type: "invoke_end",
      tool_id: "get_weather",
      invocation_id: id,
      took_ms: 5,
      result_size_bytes: 1,
    } as Parameters<typeof publisher.publish>[0]);
  }
  await publisher.close();
  return { rejected, events: status.snapshot().events };
}

async function sendSpan(url: string): Promise<ExportResultCode> {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  provider.getTracer("t").startSpan("chat").end();
  const exporter = new OTLPTraceExporter({
    url: `${url}/traces`,
    headers: { Authorization: `Bearer ${SECRET_KEY}` },
  });
  const result = await new Promise<{ code: ExportResultCode }>((resolve) =>
    exporter.export(memory.getFinishedSpans(), resolve),
  );
  await exporter.shutdown();
  return result.code;
}

test("the routes' queued answers: sent once, no reject, and stored by the worker", async () => {
  const deployment = await setupDeployment();
  const ingestQueue = {
    enabled: () => true,
    enqueue: (batch: Parameters<typeof enqueueIngestBatch>[0]) =>
      enqueueIngestBatch(batch, deployment.db),
    scheduleDrain: () => undefined,
  };
  const server = await serve((request) =>
    request.url.endsWith("/v1/traces")
      ? handleTracesRequest(request, tracesRouteDeps(deployment, { ingestQueue }))
      : handleRuntimeEventsRequest(request, eventsRouteDeps(deployment, { ingestQueue })),
  );
  const { rejected, events } = await sendEvents(server.url);
  assert.deepEqual(rejected, []);
  assert.deepEqual(
    [events.lastOutcome?.kind, events.lastOutcome?.status, events.rejected, events.dropped],
    ["ok", 202, 0, 0],
  );
  // The answer counts nothing as accepted yet, and so does the SDK's own counter.
  assert.equal(events.accepted, 0);
  assert.equal(await sendSpan(server.url), ExportResultCode.SUCCESS);
  assert.deepEqual(server.requests, ["/api/v1/events", "/api/v1/traces"]);
  await drainLane(deployment);
  assert.equal((await dumpTables(deployment)).trace_events.length >= 2, true);
  await server.close();
  await deployment.client.close();
});

test("a gateway's answers: sent once, no reject, every event accepted", async () => {
  const server = await serve(gateway);
  const { rejected, events } = await sendEvents(server.url);
  assert.deepEqual(rejected, []);
  assert.deepEqual(
    [events.lastOutcome?.kind, events.accepted, events.rejected, events.dropped],
    ["ok", 2, 0, 0],
  );
  assert.equal(await sendSpan(server.url), ExportResultCode.SUCCESS);
  assert.deepEqual(server.requests, ["/api/v1/events", "/api/v1/traces"]);
  await server.close();
});
