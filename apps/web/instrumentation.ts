/**
 * Next runs register() once at server startup, before the first request, which is where an
 * invalid composition has to be caught: without this, the server reports itself ready and then
 * answers every request with a 500, so a rolling deploy promotes the broken build.
 *
 * The framework logs an instrumentation failure and carries on serving, so failing fast has to
 * be explicit. Exiting here turns a silently degraded container into one that never becomes
 * healthy, which is what an orchestrator needs to stop the rollout.
 */
export async function register() {
  try {
    await import("@/lib/composition");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
