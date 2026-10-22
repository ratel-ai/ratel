/**
 * Node-only boot check. Kept out of instrumentation.ts so the Edge bundle never sees
 * process.exit (Next analyzes that file for both runtimes).
 *
 * Next logs an instrumentation failure and keeps serving, so exit here is deliberate:
 * a wrong RATEL_COMPOSITION must never become a healthy container.
 */
export async function assertComposition(): Promise<void> {
  try {
    await import("@/lib/composition");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
