import { cache } from "react";
import { composition } from "@/lib/composition/ports";
import type { Session } from "@/lib/contracts/session";

/**
 * The session for this request, shared by every layout and page that renders it (React
 * `cache`). Owned port of upstream `auth-user.ts`: identity, organizations and memberships are
 * the edition's module, behind the session port, so the core reads no identity table.
 * Callers must check `isDbConfigured()` before invoking, as upstream's did.
 */
export type SessionContext = Session;

export const getSessionContext = cache(
  async (): Promise<SessionContext | null> => composition.session.resolveSession(),
);

/** Upstream kept a second resolver for flag evaluation; there are no flags here. */
export const getFlagSessionContext = getSessionContext;
