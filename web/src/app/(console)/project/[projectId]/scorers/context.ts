import { type FeaturePageDeps, resolveFeaturePage } from "../feature-page";

export type ScorersPageDeps = FeaturePageDeps;

/** What every Scorers page starts from: see `resolveFeaturePage`. */
export async function resolveScorersPage(
  projectId: string,
  deps?: ScorersPageDeps,
): Promise<{ projectId: string } | null> {
  const page = await resolveFeaturePage("scorers", projectId, deps);
  return page && { projectId: page.projectId };
}
