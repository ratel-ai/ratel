import type { FlagSubject } from "@/lib/contracts/feature-flags";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_MCP_APPS`: whether the MCP server publishes its `ui://` views and links
 * tools to them (MCP Apps).
 *
 * Owned (ADR-0030): off by default. Without the edition's flags port it is one
 * switch for the deployment, `FF_MCP_APPS` (or `RATEL_EXPERIMENTAL_FEATURES` in
 * the open-source edition), read from the environment; with it, the edition
 * decides it for the project key or the person (`featureEnabled`), and a failed
 * read is off. The function keeps upstream's name and its caller argument so
 * the route handler stays as upstream's.
 *
 * Off means the server is byte-for-byte what it was without views
 * (`route-handler.apps.test.ts` pins it).
 */
export const MCP_APPS_FLAG = "FF_MCP_APPS" as const;

export interface McpAppsFlagOptions {
  /**
   * The request is the `initialize` of a client that shows views. Upstream's
   * flag service waits longer there; the environment has nothing to wait for.
   */
  initialize?: boolean;
}

export async function mcpAppsEnabled(
  auth: McpAuthContext,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return featureEnabled(MCP_APPS_FLAG, flagSubjectOf(auth), { env });
}

/** Who asks, as the caller's credential says: a project key, or a person. */
function flagSubjectOf(auth: McpAuthContext): FlagSubject {
  if (auth.kind === "api-key") {
    return {
      ...(auth.organization ? { organizationId: auth.organization.id } : {}),
      projectId: auth.projectId,
      actor: `project:${auth.projectId}`,
    };
  }
  return { actor: auth.externalUserId };
}
