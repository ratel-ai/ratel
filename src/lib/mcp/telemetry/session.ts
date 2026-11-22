import { createHash } from "node:crypto";
import type { McpAuthContext } from "@/lib/mcp/auth";

/**
 * Which MCP session a tool call belongs to.
 *
 * The server is stateless (lib/mcp/route-handler.ts): it issues no
 * `Mcp-Session-Id`, so most clients send none, and it never sees a tools/call's
 * `initialize` with the client's name. The one id it does issue goes to a client
 * that shows views, with `FF_MCP_APPS` on (lib/mcp/apps/client-views.ts). A
 * client that does send the header is taken at its word, so that client's calls
 * are grouped by that id. Otherwise the session is derived from the credential, the
 * client (its User-Agent product) and a fixed 30 minute window.
 *
 * Fixed windows, not an idle timeout: production runs three tasks behind an ALB
 * with no affinity, so an in-memory idle timer would give each task its own
 * session for one conversation. A fixed window gives every task the same id, at
 * the cost of splitting a conversation that crosses a window edge.
 */

export const DERIVED_SESSION_WINDOW_MS = 30 * 60 * 1000;

const SESSION_HEADER = "mcp-session-id";
const UNKNOWN_CLIENT = "unknown";

export type McpSession = { id: string; source: "header" | "derived" };

export function mcpSessionId(
  headers: Pick<Headers, "get"> | null,
  credentialId: string,
  clientName: string,
  nowMs: number,
): McpSession {
  const sent = headers?.get(SESSION_HEADER)?.trim();
  if (sent) return { id: sent, source: "header" };

  const window = Math.floor(nowMs / DERIVED_SESSION_WINDOW_MS);
  const digest = createHash("sha256")
    .update(`${credentialId}\n${clientName}\n${window}`)
    .digest("hex")
    .slice(0, 32);
  return { id: `derived-${digest}`, source: "derived" };
}

/** The MCP client's name from its User-Agent product token, e.g. `claude-code`. */
export function mcpClientName(headers: Pick<Headers, "get"> | null): string {
  const product = headers?.get("user-agent")?.trim().split(/[\s/]/, 1)[0];
  return product || UNKNOWN_CLIENT;
}

/** The credential behind a call: the key or the user, by id, never the secret. */
export function mcpCredentialId(auth: McpAuthContext): string {
  return auth.kind === "api-key" ? `key:${auth.apiKeyId}` : `user:${auth.userId}`;
}
