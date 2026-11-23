import { permanentRedirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";

/**
 * Dashboards are gone: Overview carries the numbers, and its Spend opens the
 * context split this page used to show.
 */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(`${projectRoot(projectId)}?peek=context`);
}
