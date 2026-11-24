import { notFound } from "next/navigation";
import { ModelSettingsView } from "@/components/console/org/ModelSettings";
import { composition } from "@/lib/composition";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import { loadModelSettings, OSS_EDITION } from "@/lib/console/settings/models";

export const metadata = { title: "Models" };
export const dynamic = "force-dynamic";

/** The deployment's models (ADR-0009 §13): read-only, the open-source edition's. */
export default async function OrganizationModelsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (composition.edition !== OSS_EDITION) notFound();
  const { orgSlug } = await params;
  await requireOrganizationScope(orgSlug);
  const settings = await loadModelSettings();
  return <ModelSettingsView slug={orgSlug} settings={settings} now={new Date()} />;
}
