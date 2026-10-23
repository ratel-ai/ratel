/**
 * Next runs register() once at server startup, before the first request, which is where an
 * invalid composition has to be caught: without this, the server reports itself ready and then
 * answers every request with a 500, so a rolling deploy promotes the broken build.
 *
 * The Node-only work lives in instrumentation.node.ts so Edge instrumentation never sees
 * process.exit.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertComposition } = await import("./instrumentation.node");
    await assertComposition();
  }
}
