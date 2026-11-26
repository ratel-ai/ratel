import { ChartColumn } from "lucide-react";
import type { ReactNode } from "react";
import { WidgetCardBody } from "@/components/console/dashboards/WidgetCardBody";
import {
  type EmptyWindow,
  TracesAction,
  WidgetEmpty,
} from "@/components/console/home/focused/WidgetEmpty";
import { NotLoaded } from "@/components/console/home/focused/widget-bodies";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import { isEmptyResult } from "@/lib/views/dashboards/chart-model";
import type { DashboardItem } from "@/lib/views/home/dashboard-items";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import {
  type DashboardItemId,
  isDashboardItem,
  type OverviewItemId,
} from "@/lib/views/overview-layout/domain/layout";

/** The dashboard widgets of the Overview, apart from its own widgets: they bring every chart there is. */

/** What the card of a dashboard widget says of it. */
export interface ItemFrame {
  /** Null where only the layout has a name for it. */
  title: string | null;
  dashboard: { name: string; href: string } | null;
  /** Why there is nothing to draw, or null. */
  problem: string | null;
}

export type ItemFrames = Readonly<Partial<Record<OverviewItemId, ItemFrame>>>;

/** A read that failed leaves no frame: the layout has the name, and the body says so. */
export function itemFrames({ dashboards }: Pick<FocusedOverviewData, "dashboards">): ItemFrames {
  if (dashboards === null || dashboards === "failed") return {};
  const entries = Object.entries(dashboards) as [DashboardItemId, DashboardItem][];
  return Object.fromEntries(
    entries.map(([id, item]) => [
      id,
      item.kind === "broken"
        ? { title: item.title, dashboard: null, problem: item.problem }
        : { title: item.title, dashboard: item.dashboard, problem: null },
    ]),
  );
}

/** A broken one has no body: its card says why and has the way out. */
export function itemBodies({
  dashboards,
  layout,
  project,
  root,
  window,
  rangeParam,
  tracesSeen,
}: Omit<FocusedOverviewData, "lastEventAt">): Partial<Record<OverviewItemId, ReactNode>> {
  const reload = window === 7 ? root : `${root}?range=${rangeParam}`;
  return Object.fromEntries(
    layout.flatMap(({ id }) => {
      if (!isDashboardItem(id)) return [];
      if (dashboards === "failed")
        return [[id, <NotLoaded key={id} title="This widget did not load." href={reload} />]];
      const item = dashboards?.[id];
      if (item?.kind !== "widget") return [];
      const { widget, result, range, filters } = item;
      if (!widget.missingScorer && result === null)
        return [[id, <NotLoaded key={id} title="The numbers could not be read." href={reload} />]];
      if (!widget.missingScorer && result && isEmpty(result))
        return [[id, <ItemEmpty key={id} at={{ root, window, tracesSeen }} />]];
      return [
        [
          id,
          <WidgetCardBody
            key={id}
            projectId={project.id}
            widget={widget}
            result={result}
            range={range}
            filters={filters}
            missingScorer={widget.missingScorer}
          />,
        ],
      ];
    }),
  );
}

function ItemEmpty({ at }: { at: EmptyWindow }) {
  return at.tracesSeen === "none" ? (
    <WidgetEmpty
      padded={false}
      name="item-none"
      icon={ChartColumn}
      title="No traces yet"
      description="Send traces to fill in this widget."
      action={<TracesAction {...at} />}
    />
  ) : (
    <WidgetEmpty
      padded={false}
      name="item-window"
      icon={ChartColumn}
      title={`No data in the last ${at.window} days`}
      description={
        at.tracesSeen === "before"
          ? "Send traces to fill in this widget."
          : "Nothing in these days matches this widget and its filters."
      }
      action={at.tracesSeen === "before" ? <TracesAction {...at} /> : undefined}
    />
  );
}

/** Nothing was measured, which is not a measured zero. The other kinds say it in their own drawing. */
function isEmpty(result: QueryResult): boolean {
  if (result.kind === "metric") return isEmptyResult(result);
  if (result.kind === "flow" || result.kind === "step_flow" || result.kind === "funnel")
    return result.sample.matched === 0;
  return false;
}
