import { composition } from "@/lib/composition/ports";

export { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/api-key-actions";

/**
 * Upstream's `isRestrictedBySupportSession` (`lib/admin/support/guard.ts`) over the session
 * port, so copied actions that refuse writes in a support session keep their call. Any support
 * session restricts, read-only or not, as upstream's does; the open-source edition has none.
 */
export async function isRestrictedBySupportSession(): Promise<boolean> {
  return (await composition.session.actingAs()) !== null;
}
