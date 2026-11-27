import { SlackDestinations } from "@/components/console/alerts/SlackDestinations";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { organizationSettingsRoot } from "@/lib/console/settings/tabs";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { listDestinations } from "@/lib/views/alerts/destinations";
import { slackAppStatus } from "@/lib/views/slack/app";
import { installNotice } from "@/lib/views/slack/notice";
import { getSlackConnection } from "@/lib/views/slack/store";
import { resolveAlertsPage } from "../../alerts/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

/** Where the project's alerts are sent. */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await resolveAlertsPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Settings">
        Notifications become available once setup finishes.
      </DatabaseUnavailable>
    );
  const [{ organization, role }, destinations, app, connection, query] = await Promise.all([
    requireProjectScope(page.projectId),
    listDestinations(page.projectId),
    slackAppStatus(page.organizationId),
    getSlackConnection(page.organizationId),
    searchParams,
  ]);
  return (
    <SlackDestinations
      projectId={page.projectId}
      destinations={destinations}
      canStore={secretBoxConfigured()}
      slack={{
        configured: app.kind === "edition" ? app.available : app.clientId !== null,
        editionOwned: app.kind === "edition",
        connection,
        isAdmin: role === "admin",
        settingsHref: `${organizationSettingsRoot(organization.slug)}/slack`,
      }}
      notice={installNotice(query)}
    />
  );
}
