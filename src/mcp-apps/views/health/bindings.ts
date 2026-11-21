import type { ViewBindings } from "../../shell/types";

/**
 * The health card: "is my agent OK?" as one view. The score, the open issues
 * ranked by the points fixing each wins back, an issue's example turns a click
 * away (list_issue_examples), hiding a slow tool as slow by design
 * (set_health_signal_hidden) and a fresh reading when this one is old
 * (request_analysis, get_analysis_freshness). Those tools are called from the
 * card; only get_agent_health renders it.
 */
const view: ViewBindings = {
  title: "Agent health",
  description: "The health score, the issues worth fixing first, and their example turns.",
  // The issue Panel is base-ui's Dialog (~100 KB with its floating-ui), as in the list view.
  // +70 KB since RW-26: Geist and Geist Mono, inlined in every view (~62 KB of base64).
  // +20 KB since RW-42: views compile the console's own app/globals.css (one stylesheet), ~17 KB more CSS.
  budgetKb: 590,
  bindings: [{ tool: "get_agent_health", config: {} }],
};

export default view;
