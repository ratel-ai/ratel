/**
 * The contract between the view build (`mcp-apps/`, RW-5) and the MCP server.
 *
 * The build turns each `mcp-apps/views/<view>/main.tsx` into one self-contained
 * HTML document and collects `views/<view>/bindings.ts` next to it. The server
 * only ever sees this shape: it serves `html` as the resource `ui://ratel/<view>`
 * and links each bound tool to it. See README.md in this folder.
 */

/** The MIME type MCP Apps hosts render as a view (SEP-1865). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Every Ratel view lives under this URI prefix: `ui://ratel/<view>`. */
export const MCP_APP_URI_PREFIX = "ui://ratel/";

/**
 * Set on a bound tool's result so a view knows which binding rendered it, even
 * on a host that does not pass the tool's definition to the view.
 */
export const BINDING_META_KEY = "sh.ratel/binding";

/**
 * Where a bound tool's result carries the view's own model (OperationResult.view).
 * In `_meta`, never in content or structuredContent: hosts hand `_meta` to the
 * view but not to the model, so the model reads exactly what it read without views.
 */
export const VIEW_META_KEY = "sh.ratel/view";

/** One tool a view renders, and how (columns, filters, formats; the view's own shape). */
export interface McpAppBinding {
  /** The MCP tool name (an operation id, or `whoami`). */
  tool: string;
  /** View-specific configuration. The server never reads it; the view does. */
  config?: Record<string, unknown>;
}

/** One built view, as the view build emits it. */
export interface McpAppView {
  /** Lowercase slug, the `<view>` in `ui://ratel/<view>`. */
  view: string;
  /** Shown by hosts that list resources. Defaults to the slug. */
  title?: string;
  description?: string;
  /** The whole document: scripts and styles inlined, no external URLs. */
  html: string;
  bindings: readonly McpAppBinding[];
}

export function mcpAppUri(view: string): string {
  return `${MCP_APP_URI_PREFIX}${view}`;
}
