import {
  type EmptyWindow,
  TracesAction,
  WidgetEmpty,
} from "@/components/console/home/focused/WidgetEmpty";

/** The map before there is anything on it: no traces yet, none in the window, or none that names an agent. */
export function TopologyEmpty(at: EmptyWindow) {
  return <WidgetEmpty figure={<GhostMap />} {...copy(at)} action={<TracesAction {...at} />} />;
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

/** Boxes and lines with no names and no numbers, dashed so that they do not read as data. Still. */
function GhostMap() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 320 112"
      className="h-full max-w-full text-line-strong"
      fill="none"
      stroke="currentColor"
      strokeDasharray="4 4"
      data-topology-ghost=""
    >
      <path
        vectorEffect="non-scaling-stroke"
        d="M92 56 C120 56 112 24 140 24 M92 56 C120 56 112 88 140 88 M220 24 H248 M220 88 C236 88 232 24 248 24"
      />
      <rect vectorEffect="non-scaling-stroke" x="12" y="38" width="80" height="36" rx="6" />
      <rect vectorEffect="non-scaling-stroke" x="140" y="6" width="80" height="36" rx="6" />
      <rect vectorEffect="non-scaling-stroke" x="140" y="70" width="80" height="36" rx="6" />
      <rect vectorEffect="non-scaling-stroke" x="248" y="6" width="60" height="36" rx="6" />
    </svg>
  );
}
