import type { ViewBindings } from "../../shell/types";

/** The Overview as the person arranged it on the web. A change of the layout draws the result. */
const view: ViewBindings = {
  title: "Overview",
  description: "The project's Overview: the widgets a person keeps, in their order, or one widget.",
  bindings: [
    { tool: "get_overview", config: {} },
    { tool: "change_overview_layout", config: {} },
  ],
};

export default view;
