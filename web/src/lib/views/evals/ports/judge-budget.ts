/** The daily spend of the judge that Ratel pays, for each organization and UTC day. */
export interface JudgeBudget {
  /** Holds `usd` when the day's spend with it stays within `maxUsd`. */
  hold(organizationId: string, day: string, usd: number, maxUsd: number): Promise<boolean>;
  /** Replaces what was held with what was spent. */
  settle(organizationId: string, day: string, heldUsd: number, spentUsd: number): Promise<void>;
}
