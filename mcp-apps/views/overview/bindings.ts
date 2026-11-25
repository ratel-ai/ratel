import type { ViewBindings } from "../../shell/types";

/** The Overview as the person arranged it on the web. A change, an undo and a restore draw the result. */
const view: ViewBindings = {
  title: "Overview",
  description:
    "The project's Overview: the widgets a person keeps, in their order, one widget, or the changes of the layout.",
  bindings: [
    { tool: "get_overview", config: {} },
    { tool: "change_overview_layout", config: {} },
    { tool: "list_overview_changes", config: {} },
    { tool: "undo_overview_change", config: {} },
    { tool: "restore_overview_layout", config: {} },
  ],
};

export default view;
