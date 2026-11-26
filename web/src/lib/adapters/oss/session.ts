import { type Config, getConfig } from "@/config";
import { requestRead } from "@/lib/contracts/request-read";
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

export interface OssSessionDeps {
  /** `requestRead()`: resolves once there is a request, never in a prerender. */
  connection: () => Promise<void>;
}

/**
 * The session waits for a request, as a signed-in edition's does by reading its cookie. Under Cache
 * Components a render path is prerendered at build up to its first request read: a session that
 * answers at once would bake the build's organization name (`RATEL_ORG_NAME`, set on the running
 * image) into the page, and would let a page that should stop at its session prerender past it.
 */
export function createOssSession(deps: OssSessionDeps = { connection: requestRead }): SessionPort {
  return {
    async resolveSession() {
      await deps.connection();
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
}

export const ossSession: SessionPort = createOssSession();
