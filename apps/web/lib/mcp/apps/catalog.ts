import { type McpAppBinding, type McpAppView, mcpAppUri } from "@/lib/mcp/apps/types";

const VIEW_NAME = /^[a-z][a-z0-9-]*$/;

/** A view build that cannot be served as it is: a bug in a view's bindings, never a caller's. */
export class McpAppCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAppCatalogError";
  }
}

export interface BoundTool {
  view: string;
  uri: string;
  binding: McpAppBinding;
}

/** The views the server publishes, checked against the tools it registers. */
export interface McpAppCatalog {
  readonly views: readonly McpAppView[];
  /** The view a tool is bound to, if any. */
  boundTool(toolId: string): BoundTool | undefined;
}

/**
 * Check the built views against the tool names the server registers, and index
 * them by tool.
 *
 * Every binding must name a registered tool, and a tool renders in at most one
 * view: a host can link a tool to one resource only. A failure throws, so a
 * binding to a renamed or removed tool breaks the test suite and the build
 * rather than publishing a link to nothing.
 */
export function buildMcpAppCatalog(
  views: readonly McpAppView[],
  toolIds: ReadonlySet<string>,
): McpAppCatalog {
  const byTool = new Map<string, BoundTool>();
  const seenViews = new Set<string>();

  for (const view of views) {
    if (!VIEW_NAME.test(view.view)) {
      throw new McpAppCatalogError(`View "${view.view}" must be a lowercase slug (a-z, 0-9, -).`);
    }
    if (seenViews.has(view.view)) {
      throw new McpAppCatalogError(`View "${view.view}" is declared twice.`);
    }
    seenViews.add(view.view);
    if (typeof view.html !== "string" || view.html.length === 0) {
      throw new McpAppCatalogError(`View "${view.view}" has no HTML.`);
    }

    for (const binding of view.bindings) {
      if (!toolIds.has(binding.tool)) {
        throw new McpAppCatalogError(
          `View "${view.view}" binds tool "${binding.tool}", which the MCP server does not register.`,
        );
      }
      const existing = byTool.get(binding.tool);
      if (existing) {
        throw new McpAppCatalogError(
          `Tool "${binding.tool}" is bound to both "${existing.view}" and "${view.view}"; a tool renders in one view.`,
        );
      }
      byTool.set(binding.tool, { view: view.view, uri: mcpAppUri(view.view), binding });
    }
  }

  return {
    views,
    boundTool: (toolId) => byTool.get(toolId),
  };
}
