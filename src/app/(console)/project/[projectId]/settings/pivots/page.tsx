import { notFound } from "next/navigation";
import { PivotsSettings } from "@/components/console/settings/PivotsSettings";
import { requireProjectScope } from "@/components/console/settings/project-scope";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { pivotsVisible } from "@/lib/console/pivots/reader";
import { type PivotCandidate, rankCandidates } from "@/lib/ingest/pivots/candidates";
import { sampleRootSpans } from "@/lib/ingest/pivots/candidates-query";
import { pivotKeys } from "@/lib/ingest/pivots/model";
import { listPivots } from "@/lib/ingest/pivots/store";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";

export const metadata = { title: "Pivots" };

/**
 * Settings > Pivots (RC-881): the attributes the project slices its traces
 * by, with candidate keys from recent root spans (RC-882). Only for a member
 * of the project's organization; for anyone else, the page does not exist.
 */
export default async function PivotsSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        Pivots become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  const { project } = await requireProjectScope(projectId);
  if (!(await pivotsVisible(project.id))) notFound();
  const pivots = await listPivots(project.id, getDb());
  const candidates = await loadCandidates(
    project.id,
    pivots.flatMap((pivot) => pivotKeys(pivot)),
  );
  return <PivotsSettings projectId={project.id} pivots={pivots} candidates={candidates} />;
}

/** The suggestions; a slow or failed read shows none rather than failing the page. */
function loadCandidates(projectId: string, configuredKeys: string[]): Promise<PivotCandidate[]> {
  return loadOrFallback<PivotCandidate[]>({
    operation: "pivot_candidates",
    distinctId: `project:${projectId}`,
    fallback: [],
    load: async () =>
      rankCandidates(
        await withStatementTimeout((db) => sampleRootSpans(projectId, db), {
          operation: "pivot_candidates",
          timeoutMs: supplementaryReadTimeoutMs(),
        }),
        { configuredKeys },
      ),
  });
}
