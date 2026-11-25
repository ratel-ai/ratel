import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { ViewBindings } from "../../shell/types";

/**
 * A dashboard's widgets on their stored grid, read-only, or the results of one to four queries:
 * both tools carry the console's own widgets and results in their result's `view`.
 */
export const dashboardBindings: McpAppBinding[] = [
  { tool: "get_dashboard" },
  { tool: "query_monitoring" },
];

const view: ViewBindings = {
  title: "Dashboard",
  description:
    "A dashboard's widgets as the console draws them: charts, tables, flows, step flows, funnels, clusters and maps.",
  // The world's and the states' shapes of the map (~210 KB), d3-geo and d3-sankey, on top of the
  // shell and Geist. Clusters are a table here (clusters-table.tsx), so no Intents map. The step flow is drawn with
  // the Health map's ribbons and layout (~35 KB).
  budgetKb: 745,
  bindings: dashboardBindings,
};

export default view;
