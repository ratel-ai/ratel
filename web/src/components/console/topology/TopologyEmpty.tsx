import {
  type EmptyWindow,
  TracesAction,
  WidgetEmpty,
} from "@/components/console/home/focused/WidgetEmpty";

/** The map before there is anything on it: no traces yet, none in the window, or none that names an agent. */
export function TopologyEmpty(at: EmptyWindow) {
  return <WidgetEmpty shape="topology" {...copy(at)} action={<TracesAction {...at} />} />;
}

function copy({ tracesSeen, window }: EmptyWindow) {
  if (tracesSeen === "none")
    return {
      name: "topology-none",
      title: "No traces yet",
      description: "Send traces and your agents and MCP servers show up here.",
    };
  if (tracesSeen === "before")
    return {
      name: "topology-window",
      title: `No traces in the last ${window} days`,
      description: "Send traces and your agents and MCP servers show up here again.",
    };
  return {
    name: "topology-unnamed",
    title: "No agents or MCP servers in this window",
    description: "Send traces whose spans name an agent (gen_ai.agent.name) or call an MCP server.",
  };
}
