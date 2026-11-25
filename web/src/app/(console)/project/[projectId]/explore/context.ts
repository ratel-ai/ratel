import { type FeaturePageDeps, resolveFeaturePage } from "../feature-page";

/** What the Explore page starts from: see `resolveFeaturePage`. */
export function resolveExplorePage(projectId: string, deps?: FeaturePageDeps) {
  return resolveFeaturePage("explore", projectId, deps);
}
