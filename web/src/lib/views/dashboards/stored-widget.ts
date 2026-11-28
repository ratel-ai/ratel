import { freePosition, gridPositionSchema } from "@/lib/views/dashboards/layout";
import { type ParseWidgetOptions, parseWidget } from "@/lib/views/dashboards/parse-widget";
import {
  type BrokenWidget,
  type DashboardWidget,
  type GridPosition,
  MAX_WIDGET_TITLE,
  type Widget,
} from "@/lib/views/dashboards/types";

/**
 * The widget list as it is stored. Each item passes the editor's own schema again as it is read:
 * the contract may have moved since, or something else wrote it. One that fails is a broken entry,
 * and the rest of the dashboard is untouched. Safe for the browser.
 */

export function isBroken(widget: DashboardWidget): widget is BrokenWidget {
  return "problem" in widget;
}

export function isWidget(widget: DashboardWidget): widget is Widget {
  return !isBroken(widget);
}

/** The stored list in today's shape (`parseWidget`): the store gives the chart of an older RQL widget. */
export function readWidgets(stored: unknown, options: ParseWidgetOptions = {}): DashboardWidget[] {
  const items: unknown[] = Array.isArray(stored) ? stored : [];
  const ids = new Set<string>();
  const read = items.map((raw) => {
    const result = readWidget(raw, ids, options);
    if (result.ok) ids.add(result.widget.id);
    return result;
  });
  const widgets: (DashboardWidget | null)[] = read.map((item) => (item.ok ? item.widget : null));
  // The good ones first: a broken one never takes their id or their place.
  const placed = (item: DashboardWidget | null) => item !== null;
  for (const [index, item] of read.entries()) {
    if (item.ok) continue;
    const { id: rawId, title, layout: rawLayout } = record(items[index]);
    const wanted = typeof rawId === "string" && rawId ? rawId : `broken-${index + 1}`;
    const id = ids.has(wanted) ? freeId(index, ids) : wanted;
    ids.add(id);
    const layout = gridPositionSchema.safeParse(rawLayout);
    const name = typeof title === "string" ? title.trim().slice(0, MAX_WIDGET_TITLE) : "";
    widgets[index] = {
      id,
      title: name || `Widget ${index + 1}`,
      layout: layout.success ? layout.data : freePosition(widgets.filter(placed)),
      problem: item.problem,
      stored: items[index],
    };
  }
  return widgets.filter(placed);
}

/** A broken entry goes back as it was, with the id and the place a person sees it by. */
export function writeWidgets(widgets: readonly DashboardWidget[]): unknown[] {
  return widgets.map((widget) =>
    isBroken(widget) ? { ...record(widget.stored), id: widget.id, layout: widget.layout } : widget,
  );
}

function readWidget(
  raw: unknown,
  ids: ReadonlySet<string>,
  options: ParseWidgetOptions,
): { ok: true; widget: Widget } | { ok: false; problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, problem: "The widget is not an object." };
  const { id, layout, missingScorer, ...rest } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return { ok: false, problem: "The widget has no id." };
  if (ids.has(id)) return { ok: false, problem: "Another widget has the same id." };
  const parsed = parseWidget(rest, options);
  if (!parsed.ok) return { ok: false, problem: parsed.error };
  const place = gridPositionSchema.safeParse(layout);
  if (!place.success)
    return { ok: false, problem: "The layout must be x, y, w and h on 12 columns." };
  if (missingScorer !== undefined && typeof missingScorer !== "string")
    return { ok: false, problem: "The widget settings are invalid." };
  return {
    ok: true,
    widget: {
      ...parsed.widget,
      id,
      layout: place.data as GridPosition,
      ...(missingScorer ? { missingScorer } : {}),
    },
  };
}

function freeId(index: number, ids: ReadonlySet<string>): string {
  let id = `broken-${index + 1}`;
  while (ids.has(id)) id += "-";
  return id;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
