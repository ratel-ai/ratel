import { redirect } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import { resolveScorersPage } from "./context";

export const dynamic = "force-dynamic";

/** No page lists scorers: each is picked where it is used. An old link to the list opens Dashboards. */
export default async function ScorersPage({ params }: { params: Promise<{ projectId: string }> }) {
  const page = await resolveScorersPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Scorers">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  redirect(dashboardsHref(page.projectId));
}
