import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { ViewBindings } from "../../shell/types";

/**
 * One trace as the console's trace page shows it: get_trace carries the page's
 * own TraceView props in its result's `view` (lib/traces/v2/trace-view-props.ts).
 */
export const traceBindings: McpAppBinding[] = [{ tool: "get_trace" }];

const view: ViewBindings = {
  title: "Trace",
  description:
    "One trace as the console shows it: its numbers, timeline, step inspector, conversation and details.",
  // The console's TraceView (timeline, span inspector, conversation, details, Tabs)
  // and the generic detail body it falls back to, on top of the shell and Geist.
  // +20 KB since RW-42: views compile the console's own app/globals.css (one stylesheet), ~17 KB more CSS.
  budgetKb: 620,
  bindings: traceBindings,
};

export default view;
