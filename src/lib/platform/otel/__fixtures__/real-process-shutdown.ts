// Fixture for shutdown.process.test.ts — NOT a test file (no `.test.ts`).
//
// Installs the app's real termination handlers on the real `process`, exactly as
// instrumentation.node.ts does in the deployed container (with NEXT_MANUAL_SIG_HANDLE=1
// so Next registers none of its own). It then keeps the event loop alive, so the
// ONLY way this process can terminate is through our signal handler. The parent
// test sends a real SIGTERM/SIGINT and asserts the flush ran, then the process
// exited itself with the signal's conventional code.
import { appendFileSync } from "node:fs";
import { createTelemetryShutdown, registerTelemetryShutdownHandlers } from "../shutdown";

const markerFile = process.env.SHUTDOWN_MARKER_FILE;
const noFlush = async () => {};

const shutdown = createTelemetryShutdown({
  tracerProvider: {
    async forceFlush() {
      // Durable, synchronous proof the flush ran before the process exited —
      // survives the process.exit() that stdout piping would race.
      if (markerFile) appendFileSync(markerFile, "flushed\n");
    },
  },
  loggerProvider: { forceFlush: noFlush },
  shutdownAnalytics() {},
  reportError() {},
  timeoutMs: 6_000,
});

registerTelemetryShutdownHandlers(shutdown);

process.stdout.write("READY\n");
// Keep the process alive so it can only be terminated by a signal handler.
setInterval(() => {}, 1 << 30);
