import type { ClustersView } from "@/lib/contracts/query";

/**
 * The clusters kind's answer. The stored intent map and its selection belong to
 * `views/dashboards/clusters`; this is the shape the runner hands over.
 */

/** The names a subset can pick, of the whole stored map. */
export interface ClusterNames {
  clusters: string[];
  tools: string[];
  skills: string[];
  tasks: string[];
}

export interface ClustersResult<Model = unknown, Step = unknown> {
  kind: "clusters";
  view: ClustersView;
  /** The selected part of the stored map. */
  model: Model;
  steps: Step[];
  /** When the analysis ran, ISO 8601. Null before the first one. */
  analyzedAt: string | null;
  names: ClusterNames;
}
