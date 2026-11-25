import { AlertsList } from "@/components/console/alerts/AlertsList";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { listAlertRules } from "@/lib/views/alerts/store";
import { resolveAlertsPage } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts" };

/** A project's alerts and their state. */
export default async function AlertsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const page = await resolveAlertsPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Alerts">
        Alerts need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const rules = await listAlertRules(page.projectId);
  return (
    <AlertsList
      projectId={page.projectId}
      now={new Date().toISOString()}
      alerts={rules.map(({ stateChangedAt, ...rule }) => ({
        ...rule,
        stateChangedAt: stateChangedAt?.toISOString() ?? null,
      }))}
    />
  );
}
