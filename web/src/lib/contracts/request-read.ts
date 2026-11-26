import { connection } from "next/server";

/** What Next throws when `connection()` runs with no request scope at all (`throwForMissingRequestStore`). */
const OUTSIDE_NEXT = /was called outside a request scope/;

/**
 * Marks a request-time read: Next's `connection()`. Under Cache Components a render path is
 * prerendered at build up to its first request read and keeps what it decided there; a read after
 * this waits for a real request, so a self-hoster's runtime config, database and session are never
 * frozen into the build. In a prerender it never resolves.
 *
 * Outside Next altogether (a unit test rendering a page, a script) there is no request scope and
 * nothing is prerendered, so it resolves at once. Every other refusal Next raises (inside `after()`,
 * inside a cache) still throws.
 */
export function requestRead(wait: () => Promise<void> = connection): Promise<void> {
  try {
    return wait();
  } catch (error) {
    if (error instanceof Error && OUTSIDE_NEXT.test(error.message)) return Promise.resolve();
    return Promise.reject(error);
  }
}
