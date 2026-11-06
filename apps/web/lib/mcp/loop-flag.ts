import type { McpAuthContext } from "@/lib/mcp/auth";
import { flagEnvEnabled } from "@/lib/platform/flags-env";

/**
 * Whether the improvement-loop tools (`list_insights` … `mark_fix_shipped`,
 * RC-43) are listed for this caller.
 *
 * Owned (ADR-0030): one switch for the deployment, `FF_MCP_LOOP`, read from
 * the environment and off by default. Upstream decides it per project key or
 * per organization through its flag service; the function keeps upstream's
 * name and its caller argument so the route handler stays identical.
 */
export async function mcpLoopEnabled(
  _auth: McpAuthContext,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return flagEnvEnabled(env.FF_MCP_LOOP);
}
