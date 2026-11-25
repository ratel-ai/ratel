import { type FeaturePageDeps, resolveFeaturePage } from "../feature-page";

/** What every Alerts page starts from: see `resolveFeaturePage`. */
export function resolveAlertsPage(projectId: string, deps?: FeaturePageDeps) {
  return resolveFeaturePage("alerts", projectId, deps);
}
