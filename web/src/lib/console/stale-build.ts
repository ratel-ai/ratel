import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * RC-526: a tab loaded before a deploy still holds the old build's server
 * action ids. The new server does not know them, so the call fails with an
 * UnrecognizedActionError. Only a reload fixes it: say so instead of "try again".
 */
export const STALE_BUILD_MESSAGE = "A new version of Ratel is available. Reload the page.";

/** True when a server action call failed because this tab runs an older (or newer) build than the server. */
export function isStaleBuildError(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}
