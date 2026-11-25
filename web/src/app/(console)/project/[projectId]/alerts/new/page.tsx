import { NewAlertForm } from "@/components/console/alerts/NewAlertForm";
import { NewAlertFrame } from "@/components/console/alerts/NewAlertFrame";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import {
  alertQueryOf,
  IN_FRAGMENT,
  NEW_ALERT_PARAM,
  PAGE_FILTERS_PARAM,
} from "@/lib/views/alerts/links";
import { parseAlertQuery } from "@/lib/views/alerts/parse-rule";
import { resolveAlertsPage } from "../context";
import { loadAlertForm } from "../form-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "New alert" };

/** The empty form, or the form with a widget's metric and filter. */
export default async function NewAlertPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await resolveAlertsPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="New alert">
        Alerts need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { features, form } = await loadAlertForm(page);
  const search = await searchParams;
  const value = search[NEW_ALERT_PARAM];
  const inFragment = value === IN_FRAGMENT;
  const start = parseAlertQuery(
    typeof value === "string" && !inFragment ? alertQueryOf(value) : null,
    features,
  );
  return (
    <NewAlertFrame projectId={page.projectId}>
      <NewAlertForm
        projectId={page.projectId}
        start={start.ok ? start.query : null}
        inFragment={inFragment}
        pageFilters={Boolean(search[PAGE_FILTERS_PARAM])}
        {...form}
      />
    </NewAlertFrame>
  );
}
