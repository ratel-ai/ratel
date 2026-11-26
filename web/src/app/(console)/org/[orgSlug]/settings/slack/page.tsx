import { notFound } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { SlackAppSettings } from "@/components/console/slack/SlackAppSettings";
import { APP_NAME } from "@/lib/platform/app-config";
import { dbConfigured } from "@/lib/platform/db/request";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { slackManifestUrl, slackRedirectUrl } from "@/lib/views/slack/app";
import { slackAppAdmin } from "@/lib/views/slack/app-actions";
import { savedClientId } from "@/lib/views/slack/store";
import { slackAppAccess } from "./access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Slack" };

/** The organization's Slack app, for its admins; a 404 for everyone else. */
export default async function OrganizationSlackPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!(await dbConfigured()))
    return (
      <DatabaseUnavailable title="Settings">
        Slack becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  const { orgSlug } = await params;
  const admin = await slackAppAdmin(orgSlug, slackAppAccess);
  if (!admin) notFound();
  const redirectUrl = slackRedirectUrl();
  return (
    <SlackAppSettings
      orgSlug={orgSlug}
      clientId={await savedClientId(admin.organizationId)}
      redirectUrl={redirectUrl}
      manifestUrl={slackManifestUrl(APP_NAME, redirectUrl)}
      canStore={secretBoxConfigured()}
    />
  );
}
