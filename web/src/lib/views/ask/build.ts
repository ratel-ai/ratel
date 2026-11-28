import { DOCUMENT_TYPE, DOCUMENT_VERSION } from "@/lib/views/dashboards/document";
import { defaultSize, freePosition } from "@/lib/views/dashboards/layout";
import type { GridPosition, WidgetInput } from "@/lib/views/dashboards/types";

/**
 * A new dashboard of the widgets a person kept from a draft, as a dashboard document: the
 * `import` action makes it in one write, with the checks of an import. Each widget takes the first
 * free place for its size, as a new widget does. Safe for the browser.
 */
export function draftedDashboard(name: string, widgets: readonly WidgetInput[]) {
  const placed: {
    title: string;
    query: WidgetInput["query"];
    chart: WidgetInput["chart"];
    layout: GridPosition;
  }[] = [];
  for (const { title, query, chart } of widgets)
    placed.push({ title, query, chart, layout: freePosition(placed, defaultSize(chart)) });
  return { type: DOCUMENT_TYPE, version: DOCUMENT_VERSION, name: name.trim(), widgets: placed };
}
