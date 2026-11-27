import type { Scorer } from "@/lib/views/scorers/types";

/** The scorers of the project in the scorer library (decision `scorer-library`), by id only. */
export interface ScorerLibraryPort {
  /** The project's scorers of the one scorer model (`views/scorers`), the oldest first. */
  projectScorers(projectId: string): Promise<Scorer[]>;
}
