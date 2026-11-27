/** A pinned baseline: which experiment, who pinned it and when. */
export type Baseline = { experimentId: string; pinnedBy: string; pinnedAt: Date };

/**
 * The pinned baselines. A run of one eval is pinned for its eval (decision `runs-per-eval`). A
 * suite run from before runs had one eval is pinned for the project. Each method takes the eval, or
 * null for the pin of the project.
 */
export interface BaselineStore {
  get(projectId: string, evalId?: string | null): Promise<Baseline | null>;
  /** Replaces the pin before it. */
  pin(projectId: string, baseline: Baseline, evalId?: string | null): Promise<void>;
  /** Only when it is that experiment, if one is given. False when no pin was removed. */
  unpin(projectId: string, experimentId?: string, evalId?: string | null): Promise<boolean>;
  /** The pin of each eval of the project that has one, by the eval id. */
  ofEvals(projectId: string): Promise<Map<string, Baseline>>;
}
