import { type Config, getConfig } from "@/config";
import type { Organization, Session, SessionPort, SessionUser } from "@/lib/contracts/session";

/**
 * The open-source edition is single-operator: whoever reaches the console is this user, admin of
 * this organization, and nothing about either is stored. Putting the console behind a proxy or
 * binding it to localhost is the operator's job and the README says so.
 */
export const LOCAL_OPERATOR: SessionUser = Object.freeze({
  id: "local-operator",
  externalId: "local-operator",
  // Reserved (RFC 2606), so it can never be a real inbox.
  email: "operator@ratel.invalid",
  name: "Local operator",
  username: "local-operator",
  avatarUrl: null,
});

/** Every project of this edition belongs to it. Never change it: projects are keyed on it. */
export const LOCAL_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

/** `app.organizationName` (RATEL_ORG_NAME) names it, validated at boot (`deployment-config.ts`); the slug never moves. */
export function localOrganization(config: Pick<Config, "app"> = getConfig()): Organization {
  return {
    id: LOCAL_ORGANIZATION_ID,
    name: config.app.organizationName || "Local operator",
    slug: "local",
  };
}

function localSession(): Session {
  const organization = localOrganization();
  return {
    user: LOCAL_OPERATOR,
    organization,
    role: "admin",
    memberships: [{ organization, role: "admin" }],
  };
}

export const ossSession: SessionPort = {
  async resolveSession() {
    return localSession();
  },
  async getOrganization(id) {
    return id === LOCAL_ORGANIZATION_ID ? localOrganization() : null;
  },
  async countMembers() {
    return 1;
  },
  async actingAs() {
    return null;
  },
};
