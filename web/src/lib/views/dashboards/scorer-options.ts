import { getDb } from "@/lib/platform/db/client";
import type { ScorerOption } from "@/lib/views/dashboards/types";
import { hasVerdict } from "@/lib/views/scorers/format";
import { listScorers, type ScorerDb } from "@/lib/views/scorers/store";

/** The project's scorers as a widget names them. */
export async function scorerOptions(
  projectId: string,
  db: ScorerDb = getDb(),
): Promise<ScorerOption[]> {
  return (await listScorers(projectId, db)).map((scorer) => ({
    id: scorer.id,
    name: scorer.name,
    verdict: hasVerdict(scorer),
  }));
}
