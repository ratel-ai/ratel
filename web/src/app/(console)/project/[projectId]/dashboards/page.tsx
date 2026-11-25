import { permanentRedirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";
import { dashboardsEnabled } from "./context";
import { DashboardsList } from "./list";

export const metadata = { title: "Dashboards" };

/**
 * Unless `customMonitoring` is on, dashboards are gone: Overview carries the numbers, and its Spend opens the
 * context split this page used to show.
 */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (await dashboardsEnabled(projectId)) return <DashboardsList projectId={projectId} />;
  permanentRedirect(`${projectRoot(projectId)}?peek=context`);
}
