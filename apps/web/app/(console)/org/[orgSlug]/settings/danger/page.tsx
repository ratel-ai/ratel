import { redirect } from "next/navigation";
import { OrgDangerSettings } from "@/components/console/org/OrgDangerSettings";
import { organizationSettingsRoot } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Danger zone" };

/** Organization settings > Danger zone. Without a database, General says why there is nothing to delete. */
export default async function OrganizationDangerPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  if (!isDbConfigured()) redirect(organizationSettingsRoot(orgSlug));
  return <OrgDangerSettings slug={orgSlug} />;
}
