import { AlertForm } from "@/components/console/alerts/AlertForm";
import { NewAlertFrame } from "@/components/console/alerts/NewAlertFrame";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { NEW_ALERT_PARAM } from "@/lib/views/alerts/links";
import { parseQuery } from "@/lib/views/alerts/parse-rule";
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
  const start = parseQuery(jsonOf((await searchParams)[NEW_ALERT_PARAM]), features);
  return (
    <NewAlertFrame projectId={page.projectId}>
      <AlertForm
        projectId={page.projectId}
        rule={null}
        start={start.ok ? start.query : null}
        {...form}
      />
    </NewAlertFrame>
  );
}

function jsonOf(value: string | string[] | undefined): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
