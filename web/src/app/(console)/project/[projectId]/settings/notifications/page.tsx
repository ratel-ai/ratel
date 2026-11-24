import { SlackDestinations } from "@/components/console/alerts/SlackDestinations";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { listDestinations } from "@/lib/views/alerts/destinations";
import { resolveAlertsPage } from "../../alerts/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

/** Where the project's alerts are sent. */
export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const page = await resolveAlertsPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Settings">
        Notifications become available once setup finishes.
      </DatabaseUnavailable>
    );
  return (
    <SlackDestinations
      projectId={page.projectId}
      destinations={await listDestinations(page.projectId)}
      canStore={secretBoxConfigured()}
    />
  );
}
