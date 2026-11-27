import { getDb } from "@/lib/platform/db/client";
import { listScorers, type ScorerDb } from "@/lib/views/scorers/store";
import type { ScorerLibraryPort } from "../ports/scorer-library";

/** The project's scorers of the one scorer model, through the store of `views/scorers`. */
export function createScorerLibrary(db: ScorerDb = getDb()): ScorerLibraryPort {
  return { projectScorers: (projectId) => listScorers(projectId, db) };
}
