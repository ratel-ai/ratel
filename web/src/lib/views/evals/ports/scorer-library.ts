import type { Scorer } from "@/lib/views/scorers/types";

/**
 * The scorers of the project, as the scorers module keeps them (decision `scorer-library`: one
 * scorer model). The pre-defined set is code (`domain/predefined-scorers.ts`).
 */
export interface ScorerLibrary {
  /** The oldest first. */
  projectScorers(projectId: string): Promise<Scorer[]>;
}
