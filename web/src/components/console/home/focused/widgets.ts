import type { OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

/** What the Overview calls each widget, on its card, in its menu and in Customize. */
export const WIDGET_TITLES: Readonly<Record<OverviewWidgetId, string>> = {
  metrics: "Metrics",
  topology: "Agents and MCP servers",
  health: "Health score",
  attention: "Needs attention",
};
