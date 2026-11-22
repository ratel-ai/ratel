/**
 * A server action that redirects (to another page, say) rejects on the client with
 * an error whose digest starts with NEXT_REDIRECT. Callers rethrow it so the
 * navigation goes through, and treat anything else as a failure.
 */
export function isRedirectError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export type RedirectingActionOutcome =
  | { navigated: true }
  | { navigated: false; error: string | null };

/**
 * Run an action that redirects on success and only returns to refuse (delete
 * project, delete organization). The router already follows the redirect, so
 * its rejection means success; a refusal comes back as its message; anything
 * else is rethrown for the caller's own failure path (ConfirmDialog's toast).
 */
export async function settleRedirectingAction(
  run: () => Promise<{ ok: boolean; error?: string } | null | undefined | void>,
): Promise<RedirectingActionOutcome> {
  try {
    const result = await run();
    return {
      navigated: false,
      error: result && result.ok === false ? (result.error ?? null) : null,
    };
  } catch (error) {
    if (isRedirectError(error)) return { navigated: true };
    throw error;
  }
}
