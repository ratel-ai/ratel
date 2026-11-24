import { ScorerForm } from "@/components/console/scorers/ScorerForm";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getTraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { resolveScorersPage } from "../context";
import { loadTaskOptions } from "../tasks";

export const dynamic = "force-dynamic";
export const metadata = { title: "New scorer" };

const WEEK_MS = 7 * 86_400_000;

export default async function NewScorerPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  /** `task`: the task to start from (a task page's link). */
  searchParams?: Promise<{ task?: string | string[] }>;
}) {
  const page = await resolveScorersPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="New scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const [facets, tasks, search] = await Promise.all([
    getTraceFilterFacets(projectId, { since: new Date(Date.now() - WEEK_MS) }),
    loadTaskOptions(projectId),
    searchParams,
  ]);
  return (
    <ScorerForm
      projectId={projectId}
      facets={facets}
      tasks={tasks}
      initialTask={tasks.find(({ id }) => id === search?.task)?.id}
      scorer={null}
    />
  );
}
