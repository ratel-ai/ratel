import type { LayoutRecord, LayoutWrite } from "../domain/history";

/** Whose layout, of which project. */
export interface LayoutKey {
  projectId: string;
  personId: string;
}

export interface OverviewLayoutStore {
  /** The layout and its history as one state; the stored value as it is, for `readArrangement`. */
  read(key: LayoutKey): Promise<LayoutRecord>;
  /**
   * Stores what `next` makes of the current state, with its entry, or leaves it on null. Two
   * changes at the same time run one after the other. The oldest entry above `KEPT_CHANGES` goes
   * in the same transaction. Gives the state after it.
   */
  update(
    key: LayoutKey,
    next: (current: LayoutRecord) => LayoutWrite | null,
  ): Promise<LayoutRecord>;
}
