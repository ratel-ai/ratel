import assert from "node:assert/strict";
import { test } from "node:test";
import { registerNodeInstrumentation } from "@/instrumentation.node";

// The registration is once per process, so the worker's case has its own file.

test("the worker installs no signal handler of its own: its stop runs the returned flush", async () => {
  const listeners = () => process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  const before = listeners();
  const flush = await registerNodeInstrumentation(
    {
      APP_ROLE: "worker",
      // Nothing listens here and nothing is emitted, so no request is ever made.
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:9/v1/logs",
    },
    {},
  );
  assert.ok(flush);
  assert.equal(listeners(), before);
  await flush();
});
