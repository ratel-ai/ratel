import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryShutdown, registerTelemetryShutdownHandlers } from "./shutdown";

test("telemetry shutdown flushes both providers and analytics once", async () => {
  const calls: string[] = [];
  const shutdown = createTelemetryShutdown({
    tracerProvider: {
      async forceFlush() {
        calls.push("traces");
      },
    },
    loggerProvider: {
      async forceFlush() {
        calls.push("logs");
      },
    },
    shutdownAnalytics() {
      calls.push("analytics");
    },
    reportError: () => {},
    timeoutMs: 50,
  });

  const first = shutdown();
  const second = shutdown();

  assert.equal(first, second);
  await first;
  assert.deepEqual(calls.sort(), ["analytics", "logs", "traces"]);
});

test("telemetry shutdown settles when an exporter never resolves", async () => {
  const shutdown = createTelemetryShutdown({
    tracerProvider: {
      forceFlush: () => new Promise<never>(() => {}),
    },
    loggerProvider: {
      async forceFlush() {},
    },
    shutdownAnalytics() {},
    reportError: () => {},
    timeoutMs: 5,
  });

  const outcome = await Promise.race([
    shutdown().then(() => "settled"),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
  ]);

  assert.equal(outcome, "settled");
});

test("telemetry shutdown reports flush failures without rejecting", async () => {
  const exportError = new Error("collector unavailable");
  const reported: unknown[] = [];
  const shutdown = createTelemetryShutdown({
    tracerProvider: {
      async forceFlush() {
        throw exportError;
      },
    },
    loggerProvider: {
      async forceFlush() {},
    },
    shutdownAnalytics() {},
    reportError: (error) => reported.push(error),
    timeoutMs: 50,
  });

  await assert.doesNotReject(shutdown());
  assert.deepEqual(reported, [exportError]);
});

test("shutdown handlers flush, then exit with the signal's conventional code", async () => {
  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const events: string[] = [];
  const handlers = new Map<string, () => void>();
  const exitCodes: number[] = [];

  registerTelemetryShutdownHandlers(
    async () => {
      events.push("flush");
    },
    {
      once(signal, handler) {
        handlers.set(signal, handler);
      },
      exit(code) {
        events.push("exit");
        exitCodes.push(code);
      },
    },
  );

  assert.deepEqual([...handlers.keys()], ["SIGTERM", "SIGINT"]);

  handlers.get("SIGTERM")?.();
  await nextTick();
  assert.deepEqual(events, ["flush", "exit"], "flush must complete before exit");
  assert.deepEqual(exitCodes, [143]);

  handlers.get("SIGINT")?.();
  await nextTick();
  assert.deepEqual(exitCodes, [143, 130]);
});
