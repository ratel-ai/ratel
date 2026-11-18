import { after } from "next/server";
import { composition } from "@/lib/composition/ports";
import type { ActingAs } from "@/lib/contracts/session";

export { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";

/**
 * Upstream's `isRestrictedBySupportSession` (`lib/admin/support/guard.ts`) over the session
 * port, so copied actions that refuse writes in a support session keep their call. Any support
 * session restricts, read-only or not, and so does a marker the edition can't resolve, as
 * upstream's cookie check does; the open-source edition has none.
 */
export async function isRestrictedBySupportSession(): Promise<boolean> {
  return (await supportSessionActingAs()) !== null;
}

/**
 * The support session that restricts this request: the one the edition resolved, or, when it only
 * sees a marker it can't resolve (a stale or forged cookie, which upstream also refuses on), a
 * read-only session with no target. Null when there is none. What write paths that take an
 * `actingAs` dependency pass, so they refuse exactly when upstream's cookie check does.
 */
export async function supportSessionActingAs(): Promise<ActingAs> {
  const session = await composition.session.actingAs();
  if (session) return session;
  return (await composition.session.supportSessionPresent?.())
    ? { kind: "organization", targetId: "", readOnly: true }
    : null;
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
