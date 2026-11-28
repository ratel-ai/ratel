import { DashboardsList } from "./list";

export const metadata = { title: "Dashboards" };

/** The project's dashboards. */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <DashboardsList projectId={projectId} />;
}
