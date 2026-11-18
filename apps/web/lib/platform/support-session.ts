import { after } from "next/server";
import { composition } from "@/lib/composition/ports";

export { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";

/**
 * Upstream's `isRestrictedBySupportSession` (`lib/admin/support/guard.ts`) over the session
 * port, so copied actions that refuse writes in a support session keep their call. Any support
 * session restricts, read-only or not, as upstream's does; the open-source edition has none.
 */
export async function isRestrictedBySupportSession(): Promise<boolean> {
  return (await composition.session.actingAs()) !== null;
}

/**
 * Upstream's `afterOutsideSupportSession` (`lib/admin/support/session.ts`): `after()` for
 * analytics that would describe the signed-in user, skipped inside a support session, where that
 * "user" is the operator or, viewing as someone, the customer. Decided now, because the callback
 * itself runs where the session can no longer be read. `schedule` is `after` outside tests.
 */
export async function afterOutsideSupportSession(
  task: () => unknown,
  schedule: (task: () => unknown) => void = after,
): Promise<void> {
  if (await isRestrictedBySupportSession()) return;
  schedule(task);
}
