import type { OrgLimitView } from "@/lib/contracts/entitlements";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { RewriteInput } from "./build";
import type { CraftKind, RoundTripPrice } from "./crafter-types";
import type { FixShipmentRow, NewFixShipmentRow } from "./schema";
import type { CraftDetail, FixEvidence, FixGain } from "./types";

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
  /** The crafter run that drafted it, for `loadDraftWindows`. */
  runId?: string;
  /** One drafted change per kind and tools (`${kind}:${sorted source ids}`): a second draft of the same change opens the first. */
  key: string;
  createdAt: string;
  toolIds: string[];
  taskIds: string[];
  intentId: string | null;
  /** The ask a `fill_gap` draft answers, for its title. */
  ask: string | null;
  why: string;
  /** What it saves over its measurement window; the build tells it as the fix's effect. */
  gain: FixGain | null;
  evidence: FixEvidence | null;
  copy: { label: string; text: string };
  detail: CraftDetail;
  /** A measured improvement: ranks first. */
  measured: boolean;
  /** Its replay came out worse: ranks last. */
  worse?: boolean;
  /** How often it applies, for ranking measured fixes. */
  score: number;
}

export interface RewriteRead {
  rewrites: RewriteInput[];
  /** Tools whose rewrite was dismissed, and when. */
  dismissed: { toolId: string; at: string }[];
}

/**
 * What a caller hands the shipment record besides the row: upstream's `TaskSimulationDeps` (the
 * gate's deps, the fix loader, the clock), opaque here and read by the seam's filler.
 */
export type ShipmentDeps = object;

export interface FixSeams {
  /** The tool crafter's pending drafts as fixes. Unset: no "craft" source. */
  loadDrafts?: (
    projectId: string,
    db: BoundReadDb,
    context: { names: ReadonlyMap<string, string>; price: RoundTripPrice },
  ) => Promise<DraftFixInput[]>;
  /**
   * The days of runs each crafter run measured, by run id (null: unknown), so a draft's savings
   * scale to a period. Read apart from the drafts: failing, the drafts stay and carry no rate.
   * Unset: no draft has a window.
   */
  loadDraftWindows?: (
    projectId: string,
    runIds: readonly string[],
    db: BoundReadDb,
  ) => Promise<Map<string, number | null>>;
  /** Quality's rewrites (pending and applied) and their dismissals. Unset: rewrites are off. */
  loadRewrites?: (
    projectId: string,
    organization: OrgLimitView,
    db: BoundReadDb,
    now: Date,
  ) => Promise<RewriteRead>;
  /**
   * Whether anything fetched the project's overrides recently. Read apart from the rewrites, so
   * a failed read leaves them listed and the adoption unknown. Unset: unknown.
   */
  loadOverrideAdoption?: (projectId: string, db: BoundReadDb, now: Date) => Promise<boolean | null>;
  /** What one model round trip costs the project, from a run's day buckets. Unset: no price. */
  priceOf?: (daily: unknown) => RoundTripPrice;
  /**
   * Records a fix as shipped in place of the plain insert: the task loop marks it live and
   * queues its tasks for measuring, in one transaction. `write` inserts the row. Unset: the
   * shipment is one inserted row.
   */
  recordShipment?: (
    input: NewFixShipmentRow,
    write: (values: NewFixShipmentRow) => Promise<FixShipmentRow>,
    db: unknown,
    deps?: ShipmentDeps,
  ) => Promise<FixShipmentRow>;
}

export const fixSeams: FixSeams = {};
