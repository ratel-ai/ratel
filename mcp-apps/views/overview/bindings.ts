import type { ViewBindings } from "../../shell/types";

/** The Overview as the person arranged it on the web. A change, an undo and a restore draw the result. */
const view: ViewBindings = {
  title: "Overview",
  description:
    "The project's Overview: the widgets a person keeps, in their order, one widget, or the changes of the layout.",
  // The dashboard widgets are drawn with the console's charts (~350 KB over the 421 KB before them):
  // the map's shapes are ~210 KB of it. Clusters are a table, as in the dashboard view.
  // React 19.3 adds ~30 KB to every view.
  budgetKb: 830,
  bindings: [
    { tool: "get_overview", config: {} },
    { tool: "change_overview_layout", config: {} },
    { tool: "list_overview_changes", config: {} },
    { tool: "undo_overview_change", config: {} },
    { tool: "restore_overview_layout", config: {} },
  ],
};

export default view;
