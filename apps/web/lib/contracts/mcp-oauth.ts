import type { SessionMembership } from "@/lib/contracts/session";

/**
 * Browser sign-in for MCP clients. The MCP endpoint is the core's and takes project API keys;
 * an edition with an identity provider may also accept the access token a client got by signing
 * in through a browser. The core hands any bearer that is not a project key to this port and
 * builds the caller's context from the answer; it never learns which provider issued the token.
 * Absent in the open-source edition, which refuses such a bearer without asking anyone.
 *
 * The discovery documents (`/.well-known/oauth-*`) are the edition's routes, not part of this
 * contract.
 */
export type McpOAuthCaller = {
  /** The identity provider's id for the user: the telemetry identity of the call. */
  externalUserId: string;
  /** The identity module's own id for this user. */
  userId: string;
  /** Every organization the user belongs to; the tools take an explicit project and check it. */
  memberships: readonly SessionMembership[];
};

/**
 * `invalid`: the token is not one the provider issued, or it expired. `unlinked`: the token is
 * good, and the person has never signed in to the console, so there is no account to act as.
 */
export type McpOAuthVerdict =
  | { ok: true; caller: McpOAuthCaller }
  | { ok: false; reason: "invalid" | "unlinked" };

export type McpOAuthPort = {
  /** A throw is logged by the route handler and answered as a 401, like any bad credential. */
  verifyAccessToken(token: string): Promise<McpOAuthVerdict>;
};
