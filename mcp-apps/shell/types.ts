import { type McpAppBinding, VIEW_META_KEY } from "@/lib/mcp/apps/types";
import type { ToolResultLike } from "./state";

/** The default export of views/<view>/bindings.ts. */
export interface ViewBindings<B extends McpAppBinding = McpAppBinding> {
  title?: string;
  description?: string;
  /** Size budget of the built file, when a view needs more than the default 490 KB. Say why. */
  budgetKb?: number;
  bindings: readonly B[];
}

/** One scenario the dev harness can open a view with (views/<view>/fixtures.ts). */
export interface ViewFixture {
  /** The tool the host says rendered the view. */
  tool: string;
  input?: Record<string, unknown>;
  /** The tool result; omit to stay in the waiting state. */
  result?: ToolResultLike;
  /** Send this instead of a result. */
  cancelled?: { reason?: string };
  /** Answers to tools/call from inside the view, by tool name. */
  calls?: Record<string, ToolResultLike>;
}

/** The default export of views/<view>/fixtures.ts: scenarios by name, the first is the default. */
export type ViewFixtures = Record<string, ViewFixture>;

/** A Ratel success result, as the server shapes it (lib/mcp/server.ts asToolResult). */
export function okResult(data: unknown, extra: Record<string, unknown> = {}): ToolResultLike {
  // As the server does (lib/mcp/server.ts asToolResult): a view's own model
  // goes to _meta, never to the text or structuredContent the model reads.
  const { view, ...rest } = extra;
  const body = { ok: true, data, ...rest };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    ...(view === undefined ? {} : { _meta: { [VIEW_META_KEY]: view } }),
  };
}

/** A Ratel failure result (lib/mcp/errors.ts toBody). */
export function errorResult(code: string, message: string): ToolResultLike {
  const body = { ok: false, error: code, message };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true,
  };
}
