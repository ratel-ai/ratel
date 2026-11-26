import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { ViewBindings } from "../../shell/types";

/**
 * The table of one RQL query: run_rql's own columns and rows (lib/mcp/operations/monitoring/rql.ts).
 * The columns change with each query, so the list view's fixed columns do not fit.
 */
export const tableBindings: McpAppBinding[] = [{ tool: "run_rql" }];

const view: ViewBindings = {
  title: "Table",
  description: "The rows of an RQL (Ratel Query Language) query: one column for each value the query selects.",
  bindings: tableBindings,
};

export default view;
