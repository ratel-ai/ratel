/** The pinned baseline of a project: which experiment, who pinned it and when. */
export type Baseline = { experimentId: string; pinnedBy: string; pinnedAt: Date };

export interface BaselineStore {
  get(projectId: string): Promise<Baseline | null>;
  /** Replaces the pin before it. */
  pin(projectId: string, baseline: Baseline): Promise<void>;
  /** Only when it is that experiment, if one is given. False when no pin was removed. */
  unpin(projectId: string, experimentId?: string): Promise<boolean>;
}
