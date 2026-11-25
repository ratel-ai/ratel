import type { StoredOverviewLayout } from "../domain/stored";

/** Whose layout, of which project. */
export interface LayoutKey {
  projectId: string;
  personId: string;
}

export interface OverviewLayoutStore {
  /** The stored value as it is, for `readArrangement`; undefined without a row. */
  read(key: LayoutKey): Promise<unknown>;
  /** Replaces the stored value with `next` of the current one. Two changes at the same time both apply. */
  update(key: LayoutKey, next: (current: unknown) => StoredOverviewLayout): Promise<void>;
}
