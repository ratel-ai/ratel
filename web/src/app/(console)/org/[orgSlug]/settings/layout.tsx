import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { composition } from "@/lib/composition";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import { organizationSettingsTabsFor } from "@/lib/console/settings/organization-tabs";
import { isDbConfigured } from "@/lib/platform/db/client";
import { slackAppAdmin } from "@/lib/views/slack/app-actions";
import { slackAppAccess } from "./slack/access";

/**
 * Organization settings share one header and its URL tabs: General for everyone, Slack for the
 * admins who configure the organization's Slack app, Danger zone for the admins who can use it, where the edition has that page. Without a database the page says so
 * on its own.
 */
export default async function OrganizationSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) return children;
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  const { organization, role } = await requireOrganizationScope(orgSlug);
  const tabs = organizationSettingsTabsFor(organization.slug, {
    role,
    hasDangerPage: Boolean(ui?.OrganizationDangerSettings),
    slackApp: (await slackAppAdmin(organization.slug, slackAppAccess)) !== null,
  });
  return (
    <SettingsFrame label="Organization settings" tabs={tabs}>
      {children}
    </SettingsFrame>
  );
}
