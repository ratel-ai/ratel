import type { McpAppCatalog } from "@/lib/mcp/apps/catalog";

/** The views that a server with these tools publishes: a view whose tools are all absent is left out. */
export function viewsFor(
  catalog: McpAppCatalog,
  hasTool: (toolId: string) => boolean,
): McpAppCatalog {
  return {
    views: catalog.views.filter(
      ({ bindings }) => bindings.length === 0 || bindings.some(({ tool }) => hasTool(tool)),
    ),
    boundTool: (toolId) => (hasTool(toolId) ? catalog.boundTool(toolId) : undefined),
  };
}
