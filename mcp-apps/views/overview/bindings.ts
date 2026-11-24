import type { ViewBindings } from "../../shell/types";

/** The Overview as the person arranged it on the web. Only get_overview renders it. */
const view: ViewBindings = {
  title: "Overview",
  description: "The project's Overview: the widgets a person shows, in their order.",
  bindings: [{ tool: "get_overview", config: {} }],
};

export default view;
