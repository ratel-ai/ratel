"use client";

import { MenuLinkItem } from "@ratel/design-system/menu";
import { Bell, Compass, ListTree } from "lucide-react";
import Link from "next/link";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import { newAlertHref } from "@/lib/views/alerts/links";
import { takesPageFilters, withPageFilters } from "@/lib/views/dashboards/filters";
import {
  type DashboardRange,
  intentsMapHref,
  widgetTracesHref,
} from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";
import { metricOfForm, queryFilter } from "@/lib/views/dashboards/widget";

/** Where a widget's menu leads, on a dashboard and in Explore. */
export function WidgetLinkItems({
  projectId,
  widget: { query },
  filters,
  range,
  exploreHref,
  alerts,
  alertWithFilters = false,
}: {
  projectId: string;
  widget: WidgetInput;
  filters: DashboardFilters;
  range: DashboardRange;
  /** The Explore page with the widget; null inside it, or for a widget that shows no numbers. */
  exploreHref: string | null;
  /** Whether a metric can start an alert. */
  alerts: boolean;
  /** The alert takes the page's filters too. */
  alertWithFilters?: boolean;
}) {
  // An alert watches the metric of a widget's form: a hand-written text has none yet.
  const metric = query.kind === "sql" && query.form ? metricOfForm(query.form) : null;
  const withFilters = alertWithFilters && metric !== null && takesPageFilters(metric, filters);
  const alertHref =
    alerts && metric
      ? newAlertHref(
          projectId,
          withFilters ? withPageFilters(metric, filters) : metric,
          withFilters,
        )
      : null;
  return (
    <>
      {exploreHref ? (
        <MenuLinkItem icon={<Compass />} render={<Link href={exploreHref} />}>
          Open in Explore
        </MenuLinkItem>
      ) : null}
      {query.kind === "clusters" ? (
        <MenuLinkItem icon={<ListTree />} render={<Link href={intentsMapHref(projectId)} />}>
          View intents
        </MenuLinkItem>
      ) : (
        <MenuLinkItem
          icon={<ListTree />}
          render={
            <Link
              href={widgetTracesHref(projectId, withClause(queryFilter(query), filters), range)}
            />
          }
        >
          View traces
        </MenuLinkItem>
      )}
      {alertHref === null ? null : (
        <MenuLinkItem icon={<Bell />} render={<Link href={alertHref} />}>
          Create alert
        </MenuLinkItem>
      )}
    </>
  );
}
