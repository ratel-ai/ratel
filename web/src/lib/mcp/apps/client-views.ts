import { randomUUID } from "node:crypto";
import { MCP_APP_MIME_TYPE } from "@/lib/mcp/apps/types";

/**
 * Whether the client on this request shows tool results as MCP Apps views, so
 * the model can be told plainly that the person already sees the data (RW-56).
 *
 * A client says so once, at `initialize`: `capabilities.extensions
 * ["io.modelcontextprotocol/ui"].mimeTypes` lists the MCP App MIME type (Claude
 * Desktop does; Claude Code does not). This server is stateless, so a later
 * tools/call arrives with no memory of that. To carry it, the initialize
 * response to such a client sets an `Mcp-Session-Id` that names it, and every
 * Streamable HTTP client sends that id back on each request. Nothing is
 * stored: the id is the whole signal. A client faking one only gets a line
 * asking for a short reply.
 *
 * The id is issued at `initialize` or never, and only with `mcpApps`
 * on for that request. So that request waits longer for the flag than any
 * other (`issueSession`, read before the flag is asked; lib/mcp/apps/flag.ts).
 *
 * Clients on the stateless protocol (2026-07-28) send their capabilities on
 * every request, in `_meta["io.modelcontextprotocol/clientCapabilities"]`; that
 * counts too.
 */

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
export const VIEW_SESSION_PREFIX = "ratel-views-";

/** Whether a capabilities object declares the MCP Apps extension with our MIME type. */
export function declaresViews(capabilities: unknown): boolean {
  const extensions = (capabilities as { extensions?: Record<string, unknown> } | null | undefined)
    ?.extensions;
  const ui = extensions?.[UI_EXTENSION] as { mimeTypes?: unknown } | undefined;
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(MCP_APP_MIME_TYPE);
}

type Message = { method?: unknown; params?: Record<string, unknown> | null };

export interface ClientViews {
  /** The client shows views: tell the model so. */
  renders: boolean;
  /** This is its initialize: answer with a session id that says so. */
  issueSession: boolean;
}

export function clientViews(messages: readonly unknown[], sessionId: string | null): ClientViews {
  let renders = sessionId?.startsWith(VIEW_SESSION_PREFIX) === true;
  let issueSession = false;
  for (const message of messages as Message[]) {
    const params = message?.params ?? undefined;
    if (message?.method === "initialize" && declaresViews(params?.capabilities)) {
      renders = true;
      issueSession = true;
    }
    const meta = params?._meta as Record<string, unknown> | undefined;
    if (declaresViews(meta?.[CLIENT_CAPABILITIES_META])) renders = true;
  }
  return { renders, issueSession };
}

export function viewSessionId(): string {
  return `${VIEW_SESSION_PREFIX}${randomUUID()}`;
}
