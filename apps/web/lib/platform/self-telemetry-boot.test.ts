import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { registerNodeInstrumentation } from "@/instrumentation.node";

// What boot registers for the platform's own telemetry (`instrumentation.node.ts`), against a
// collector on this machine. The registration is once per process, so the unset cases run first.

const received: { path: string; body: string }[] = [];
let collector: Server;
let origin = "";

before(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

after(async () => {
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
});

const signalListeners = () => process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

function recordingSpan(): boolean {
  const span = trace.getTracer("self-telemetry-boot").startSpan("probe");
  const recording = span.isRecording();
  span.end();
  return recording;
}

async function warningsOf(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("with the endpoints unset nothing is registered and nothing is exported", async () => {
  const listeners = signalListeners();
  const warnings = await warningsOf(async () => {
    assert.equal(await registerNodeInstrumentation({}, {}), undefined);
  });
  assert.deepEqual(warnings, []);
  assert.equal(recordingSpan(), false, "no tracer provider was registered");
  assert.equal(signalListeners(), listeners, "no signal handler was installed");
  assert.equal(received.length, 0);
});

test("one endpoint alone is a warning, and still nothing is registered", async () => {
  const warnings = await warningsOf(async () => {
    assert.equal(
      await registerNodeInstrumentation(
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${origin}/v1/traces` },
        {},
      ),
      undefined,
    );
  });
  assert.ok(warnings.some((warning) => warning.includes("logs exporter could not be resolved")));
  assert.equal(recordingSpan(), false);
  assert.equal(received.length, 0);
});

test("the emergency stop wins over both endpoints", async () => {
  assert.equal(
    await registerNodeInstrumentation(
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${origin}/v1/traces`,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${origin}/v1/logs`,
        OTEL_SDK_DISABLED: "true",
      },
      {},
    ),
    undefined,
  );
  assert.equal(recordingSpan(), false);
});

test("with both endpoints set the process exports its traces and logs, and the flush sends them", async () => {
  const listeners = signalListeners();
  const environment = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${origin}/v1/traces`,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer t",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${origin}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer l",
  };
  const flush = await registerNodeInstrumentation(environment, {
    deploymentEnvironment: "staging",
  });
  assert.ok(flush);
  assert.equal(signalListeners(), listeners + 2, "SIGTERM and SIGINT flush before the exit");
  assert.equal(
    await registerNodeInstrumentation(environment, {}),
    flush,
    "a second call keeps the first registration",
  );

  trace.getTracer("self-telemetry-boot").startSpan("boot-test-span").end();
  logs.getLogger("self-telemetry-boot").emit({ body: "boot-test-log" });
  assert.equal(received.length, 0, "batched, not sent yet");

  await flush();
  const traces = received.find((request) => request.path === "/v1/traces");
  const logRecords = received.find((request) => request.path === "/v1/logs");
  assert.ok(traces?.body.includes("boot-test-span"));
  assert.ok(logRecords?.body.includes("boot-test-log"));
  for (const request of [traces, logRecords]) {
    assert.ok(request?.body.includes("ratel-platform"), "the resource names this service");
    assert.ok(request?.body.includes("staging"), "and the deployment environment");
  }
});
