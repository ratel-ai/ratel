import { ScorerForm } from "@/components/console/scorers/ScorerForm";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getTraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { resolveScorersPage } from "../context";

export const dynamic = "force-dynamic";
export const metadata = { title: "New scorer" };

const WEEK_MS = 7 * 86_400_000;

export default async function NewScorerPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const page = await resolveScorersPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="New scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const facets = await getTraceFilterFacets(projectId, { since: new Date(Date.now() - WEEK_MS) });
  return <ScorerForm projectId={projectId} facets={facets} scorer={null} />;
}
