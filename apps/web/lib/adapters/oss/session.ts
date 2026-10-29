import type { Principal, SessionPort } from "@/lib/contracts/session";

/**
 * The open-source edition is single-operator: whoever reaches the console is this principal.
 * Stable ids so the database rows survive restarts; a reserved `.invalid` address (RFC 2606) so
 * it can never be a real inbox. Putting the console behind a proxy or binding it to localhost is
 * the operator's job and the README says so.
 */
export const LOCAL_OPERATOR: Principal = Object.freeze({
  id: "local-operator",
  email: "operator@ratel.invalid",
  emailVerified: true,
  name: "Local operator",
  username: "local-operator",
  avatarUrl: null,
});

export const ossSession: SessionPort = {
  async resolvePrincipal() {
    return LOCAL_OPERATOR;
  },
  async accessGranted() {
    return true;
  },
  async actingAs() {
    return null;
  },
};
