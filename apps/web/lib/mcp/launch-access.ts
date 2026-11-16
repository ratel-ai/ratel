import type { McpAuthContext } from "@/lib/mcp/auth";
import { getLogger } from "@/lib/platform/logger";

/**
 * Whether this caller may use the MCP server: the same allowlist as the app, so anyone who can
 * use the console can do the same here and nobody else can (upstream RC-234).
 *
 * A project API key is not a person: it was minted in the app by someone with access, and the
 * SDK ingest it also authorizes does not ask this either, so it is let through. Revoking the key
 * is how its access ends. A signed-in caller (the `oauth` arm) is a person, decided by `decide`;
 * a grant is cached per person for five minutes, so a session of tool calls does not ask on
 * every request.
 *
 * Owned (ADR-0030): upstream decides a person through its identity provider and flag service,
 * which are the edition's. This file keeps the caching and the fail-closed rule; the decision for
 * a signed-in caller comes from the edition that supplies MCP sign-in. Without one, the open-source
 * edition, every caller is a project key.
 */
export interface LaunchAccessDeps {
  /** Whether the person behind a signed-in caller may use the app. */
  decide: (externalUserId: string) => Promise<boolean>;
  now: () => number;
}

const CACHE_MS = 5 * 60_000;
const logger = getLogger("mcp/launch-access");

export const defaultLaunchAccessDeps: LaunchAccessDeps = {
  // No edition decision is wired yet: a signed-in caller is refused, closed as the console's
  // check is. Project keys never reach this.
  decide: async () => false,
  now: () => Date.now(),
};

const decisions = new Map<string, { allowed: boolean; at: number }>();

export async function mcpLaunchAccess(
  auth: McpAuthContext,
  deps: LaunchAccessDeps = defaultLaunchAccessDeps,
): Promise<boolean> {
  if (auth.kind === "api-key") return true;

  const cached = decisions.get(auth.externalUserId);
  if (cached && deps.now() - cached.at < CACHE_MS) return cached.allowed;

  let allowed: boolean;
  try {
    allowed = await deps.decide(auth.externalUserId);
  } catch (error) {
    // Closed, as the console's check is.
    logger.error(
      { err: error, distinct_id: auth.externalUserId },
      "mcp launch access decision failed",
    );
    return false;
  }
  // Only a grant is cached. A refusal can be a passing failure (the decision fails closed), and
  // caching it would lock a member out for minutes; someone granted access mid-session also gets
  // in on their next call.
  if (allowed) decisions.set(auth.externalUserId, { allowed, at: deps.now() });
  return allowed;
}

/** For tests: forget every cached decision. */
export function resetLaunchAccessCache(): void {
  decisions.clear();
}
