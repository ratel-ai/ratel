import type { Instrumentation } from "next";

/**
 * Next runs register() once at server startup, before the first request, which is where an
 * invalid setting or composition has to be caught: without this, the server reports itself ready and then
 * answers every request with a 500, so a rolling deploy promotes the broken build.
 *
 * The Node-only work lives in instrumentation-node.ts so Edge instrumentation never sees
 * process.exit.
 *
 * Self-telemetry registers first, so `pg` and `fetch` load already patched and the background
 * work is traced. It does nothing unless both OTLP endpoints are set.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      assertComposition,
      bootConfig,
      bootBackground,
      registerNodeInstrumentation,
      startProcessStatsIfExported,
    } = await import("./instrumentation-node");
    const config = await bootConfig();
    const flushTelemetry = await registerNodeInstrumentation(config, {
      deploymentEnvironment: config.app.environment,
    });
    await startProcessStatsIfExported(config);
    await assertComposition();
    await bootBackground(flushTelemetry);
  }
}

/**
 * Uncaught server-side request errors (upstream's `onRequestError`), handed to the edition's
 * telemetry port. Node runtime only; the open-source edition reports nothing.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./instrumentation-node");
  await reportRequestError(error, request, context);
};
