import type { OverviewLayout } from "../domain/layout";

/** Whose layout, of which project. */
export interface LayoutKey {
  projectId: string;
  personId: string;
}

export interface OverviewLayoutStore {
  /** The person's layout, or the default. */
  read(key: LayoutKey): Promise<OverviewLayout>;
  /** Replaces the layout with `next` of the current one. Two changes at the same time both apply. */
  update(
    key: LayoutKey,
    next: (current: OverviewLayout) => OverviewLayout,
  ): Promise<OverviewLayout>;
}
