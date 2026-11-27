import { redirect } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";
import { resolveScorersPage } from "../context";

export const dynamic = "force-dynamic";

/**
 * A scorer is created where it is used. An old link from a task (`?task=`) opens that task, whose
 * scoring section creates one; any other opens Dashboards.
 */
export default async function NewScorerPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ task?: string | string[] }>;
}) {
  const page = await resolveScorersPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="New scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const task = (await searchParams)?.task;
  redirect(
    typeof task === "string" && task
      ? topLevelTasksHref(page.projectId, task)
      : dashboardsHref(page.projectId),
  );
}
