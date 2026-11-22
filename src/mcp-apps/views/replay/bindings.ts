import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { ViewBindings } from "../../shell/types";

/**
 * Session replay. Three tools tell a run or a session; each carries the
 * console's SessionChat in its result's `view` (lib/mcp/operations/session-chat-view.ts).
 * Published behind FF_MCP_APPS like every view; message text follows the
 * project's content opt-in and, for an API key, its content:read scope (RC-585).
 */
export const replayBindings: McpAppBinding[] = [
  { tool: "get_session" },
  { tool: "get_run_summary" },
  { tool: "get_trace_conversation" },
];

const view: ViewBindings = {
  title: "Session replay",
  description:
    "A run or a session as the console replays it: the chat, its track with playback, and each step's inspector.",
  // The console's session replay (components/session-chat) and its DS Panel on top of the shell.
  // +70 KB since RW-26: Geist and Geist Mono, inlined in every view (~62 KB of base64).
  // +20 KB since RW-42: views compile the console's own app/globals.css (one stylesheet), ~17 KB more CSS.
  budgetKb: 550,
  bindings: replayBindings,
};

export default view;
