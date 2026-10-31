import type { OrgLimitView } from "@/lib/contracts/entitlements";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { RewriteInput } from "./build";
import type { CraftKind, RoundTripPrice } from "./crafter-types";
import type { CraftDetail, FixEffect, FixEvidence, FixGain } from "./types";

/**
 * The sources of fixes that other readings supply. Fixes derived from Agent health's issues
 * and from intents no skill covers are read here; the tool crafter's drafted changes and the
 * quality rewrites arrive through these seams when those readings land. Empty, a source
 * simply contributes no fixes: it is not a failure. Same pattern as `computeSeams` in the
 * trace-signals reading.
 */

/** A drafted change (the tool crafter's), already told as a fix. */
export interface DraftFixInput {
  id: string;
  kind: CraftKind;
  /** One drafted change per kind and tools (`${kind}:${sorted source ids}`): a second draft of the same change opens the first. */
  key: string;
  createdAt: string;
  toolIds: string[];
  taskIds: string[];
  intentId: string | null;
  /** The ask a `fill_gap` draft answers, for its title. */
  ask: string | null;
  why: string;
  effect: FixEffect | null;
  gain: FixGain | null;
  evidence: FixEvidence | null;
  copy: { label: string; text: string };
  detail: CraftDetail;
  /** A measured improvement: ranks first. */
  measured: boolean;
  /** How often it applies, for ranking measured fixes. */
  score: number;
}

export interface RewriteRead {
  rewrites: RewriteInput[];
  /** Tools whose rewrite was dismissed, and when. */
  dismissed: { toolId: string; at: string }[];
  /** Whether anything fetched the project's overrides recently; null when unknown. */
  overridesAdopted: boolean | null;
}

export interface FixSeams {
  /** The tool crafter's pending drafts as fixes. Unset: no "craft" source. */
  loadDrafts?: (
    projectId: string,
    db: BoundReadDb,
    context: { names: ReadonlyMap<string, string>; price: RoundTripPrice },
  ) => Promise<DraftFixInput[]>;
  /** Dismiss one drafted change; false when it is already gone. Unset: nothing can be dismissed. */
  dismissDraft?: (projectId: string, proposalId: string, now: Date) => Promise<boolean>;
  /** Quality's rewrites (pending and applied), their dismissals and the override adoption. Unset: rewrites are off. */
  loadRewrites?: (
    projectId: string,
    organization: OrgLimitView,
    db: BoundReadDb,
    now: Date,
  ) => Promise<RewriteRead>;
  /** What one model round trip costs the project, from a run's day buckets. Unset: no price. */
  priceOf?: (daily: unknown) => RoundTripPrice;
}

export const fixSeams: FixSeams = {};
