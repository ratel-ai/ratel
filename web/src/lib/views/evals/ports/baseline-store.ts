/**
 * The pinned baseline of one eval: which experiment, who pinned it and when. `evalId` is null for
 * the pin of the suite runs from before runs had one eval (decision `runs-per-eval`).
 */
export type Baseline = {
  evalId: string | null;
  experimentId: string;
  pinnedBy: string;
  pinnedAt: Date;
};

export interface BaselineStore {
  /** The pin of the eval. With no eval: the pin of the suite runs. */
  get(projectId: string, evalId?: string | null): Promise<Baseline | null>;
  /** Replaces the pin of the same eval. */
  pin(projectId: string, baseline: Baseline): Promise<void>;
  /**
   * Removes the pin of that experiment, whatever its eval. With no experiment: the pin of the suite
   * runs. False when no pin was removed.
   */
  unpin(projectId: string, experimentId?: string): Promise<boolean>;
}
