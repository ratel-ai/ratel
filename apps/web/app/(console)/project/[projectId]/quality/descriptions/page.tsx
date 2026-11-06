import { QualityPage } from "@/components/console/quality/QualityPage";
import { QualityUnavailable } from "@/components/console/quality/states";
import { isDbConfigured } from "@/lib/platform/db/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quality descriptions" };

/**
 * Quality v2, Descriptions: how often the right tool is found, and the
 * searchable-description rewrites that would find it more often, to apply,
 * dismiss or revert. `?tool=<toolId>` opens one tool, `?peek=rewrite:<id>` one
 * rewrite: the address Fixes and Agent health link to for a description update.
 */
export default async function QualityDescriptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) return <QualityUnavailable />;
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  return <QualityPage projectId={projectId} tab="descriptions" searchParams={query} />;
}
