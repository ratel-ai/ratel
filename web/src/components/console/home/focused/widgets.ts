import { Bell, ChartNoAxesColumn, HeartPulse, type LucideIcon, Waypoints } from "lucide-react";
import {
  type OfferedWidgets,
  type OverviewLayout,
  type OverviewWidgetId,
  WIDGET_CATALOG,
  WIDGET_TITLES,
} from "@/lib/views/overview-layout/domain/layout";

/** What the Overview calls each widget, in its heading, in edit mode and in the Add widget dialog. */
export const WIDGETS: Readonly<
  Record<OverviewWidgetId, { title: string; description: string; icon: LucideIcon }>
> = {
  metrics: {
    title: WIDGET_TITLES.metrics,
    description: "Runs, failed runs, median duration and spend.",
    icon: ChartNoAxesColumn,
  },
  topology: {
    title: WIDGET_TITLES.topology,
    description: "Who hands work to whom, and what they call.",
    icon: Waypoints,
  },
  health: {
    title: WIDGET_TITLES.health,
    description: "One number for how well your agents work.",
    icon: HeartPulse,
  },
  attention: {
    title: WIDGET_TITLES.attention,
    description: "Failed runs, issues and fixes to look at.",
    icon: Bell,
  },
};

/** The widgets of a layout: it holds every one the server offers. */
export function offeredTo(layout: OverviewLayout): OfferedWidgets {
  const ids = new Set(layout.map(({ id }) => id));
  return WIDGET_CATALOG.filter(({ id }) => ids.has(id));
}
