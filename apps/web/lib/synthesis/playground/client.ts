import type { RankRequest, RankResponse } from "@/lib/synthesis/playground/contract";

/**
 * The Playground's one client-side call. Same-origin fetch carries the session
 * cookie, so this needs no credentials of its own; the route re-checks the flag,
 * the membership, and every input regardless of what is sent here.
 *
 * Publishing a skill edit deliberately does NOT go through this module. It
 * reuses the existing catalog write seam in `lib/explore/client.ts`, so a
 * Playground publish is byte-for-byte the same optimistic-concurrency PATCH the
 * catalog page performs.
 */

export type RankOutcome =
  | { ok: true; data: RankResponse }
  | { ok: false; status: number; error: string };

const FALLBACK_ERROR: Record<number, string> = {
  0: "Network error. The run never reached the server.",
  401: "Your session expired. Reload and sign in again.",
  403: "Embedding modes are not enabled for this account.",
  404: "Test a search is unavailable for this project.",
  429: "Too many embedding runs. Try again shortly.",
  503: "Test a search is temporarily unavailable.",
};

export async function rankPlayground(body: RankRequest): Promise<RankOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/playground/rank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: FALLBACK_ERROR[0] };
  }

  const payload = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string })
    | null;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error ?? FALLBACK_ERROR[response.status] ?? "The run failed. Try again.",
    };
  }
  return { ok: true, data: payload as unknown as RankResponse };
}
