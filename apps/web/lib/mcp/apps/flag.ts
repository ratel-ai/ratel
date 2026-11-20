import type { McpAuthContext } from "@/lib/mcp/auth";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_MCP_APPS`: whether the MCP server publishes its `ui://` views and links
 * tools to them (MCP Apps).
 *
 * Owned (ADR-0030): one switch for the deployment, `FF_MCP_APPS` (or
 * `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition), read from the
 * environment and off by default. Upstream decides it per project key or per
 * person through its flag service, with timeouts and a cache; reading the
 * environment neither waits nor fails, so none of that is here. The function
 * keeps upstream's name and its caller argument so the route handler stays as
 * upstream's.
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
  _auth: McpAuthContext,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return experimentalFeatureEnabled(MCP_APPS_FLAG, env);
}
