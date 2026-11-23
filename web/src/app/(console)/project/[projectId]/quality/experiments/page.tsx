import { QualityPage } from "@/components/console/quality/QualityPage";
import { QualityUnavailable } from "@/components/console/quality/states";
import { isDbConfigured } from "@/lib/platform/db/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quality experiments" };

/** Quality v2, Experiments: calibrations in plain words. */
export default async function QualityExperimentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) return <QualityUnavailable />;
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  return <QualityPage projectId={projectId} tab="experiments" searchParams={query} />;
}
