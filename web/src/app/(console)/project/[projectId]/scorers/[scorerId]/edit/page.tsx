import { notFound } from "next/navigation";
import { ScorerForm } from "@/components/console/scorers/ScorerForm";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { getTraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { getScorer } from "@/lib/views/scorers/store";
import { resolveScorersPage } from "../../context";
import { loadTaskOptions } from "../../tasks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit scorer" };

const WEEK_MS = 7 * 86_400_000;

export default async function EditScorerPage({
  params,
}: {
  params: Promise<{ projectId: string; scorerId: string }>;
}) {
  const { projectId: rawProjectId, scorerId } = await params;
  const page = await resolveScorersPage(rawProjectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Edit scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const id = parseProjectUuid(scorerId);
  const scorer = id ? await getScorer(projectId, id) : null;
  if (!scorer) notFound();
  const [facets, tasks] = await Promise.all([
    getTraceFilterFacets(projectId, { since: new Date(Date.now() - WEEK_MS) }),
    loadTaskOptions(projectId, scorer.filter.taskId),
  ]);
  const { createdAt: _created, updatedAt: _updated, projectId: _project, ...draft } = scorer;
  return <ScorerForm projectId={projectId} facets={facets} tasks={tasks} scorer={draft} />;
}
