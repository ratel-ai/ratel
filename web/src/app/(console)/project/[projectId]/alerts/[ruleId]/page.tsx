import { notFound } from "next/navigation";
import { AlertDetail } from "@/components/console/alerts/AlertDetail";
import { AlertForm } from "@/components/console/alerts/AlertForm";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { getAlertRule, listAlertEvents } from "@/lib/views/alerts/store";
import { resolveAlertsPage } from "../context";
import { loadAlertForm } from "../form-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alert" };

/** One alert: its state, its form and its history. */
export default async function AlertPage({
  params,
}: {
  params: Promise<{ projectId: string; ruleId: string }>;
}) {
  const { projectId, ruleId } = await params;
  const page = await resolveAlertsPage(projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Alert">
        Alerts need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const id = parseProjectUuid(ruleId);
  const rule = id ? await getAlertRule(page.projectId, id) : null;
  if (!rule) notFound();
  const [form, events] = await Promise.all([
    loadAlertForm(page),
    listAlertEvents(page.projectId, rule.id),
  ]);
  const { stateChangedAt, ...shown } = rule;
  return (
    <AlertDetail
      projectId={page.projectId}
      now={new Date().toISOString()}
      alert={{ ...shown, stateChangedAt: stateChangedAt?.toISOString() ?? null }}
      events={events.map((event) => ({ ...event, at: event.at.toISOString() }))}
    >
      <AlertForm projectId={page.projectId} rule={rule} start={null} {...form} />
    </AlertDetail>
  );
}
