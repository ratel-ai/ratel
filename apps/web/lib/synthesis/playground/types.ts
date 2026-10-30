import type { SkillStatus } from "@/lib/catalog/manage";
import type { DataProvenance } from "@/lib/synthesis/catalog/provenance";
import type { SearchableDescriptionSource } from "./descriptions";

/**
 * Shared shapes for the Playground: the two capability kinds the SDK's discovery
 * ranks, the what-if edits laid over them, and the ranked output.
 *
 * Skills and tools stay in SEPARATE buckets everywhere in here. That is the
 * engine's own doctrine, not a layout choice: `searchCapabilitiesTool` ranks
 * them independently precisely because BM25 scores over the two different text
 * shapes are not comparable, and a merged list would invent a ranking the agent
 * never sees.
 */

export type CapabilityKind = "skill" | "tool";

/** A catalog skill as the bench shows it. `id` is the CRUD route's UUID. */
export interface BenchSkill {
  id: string;
  /** kebab-case wire id: what the SDK indexes and what ranked ids reference. */
  name: string;
  /** What the agent receives when this skill is retrieved. */
  description: string;
  /**
   * `skills.searchable_description`: what a prompt is MATCHED against, when the
   * skill carries one. Null means retrieval reads `description` instead — the
   * common case, since most skills never set it. See `descriptions.ts`.
   */
  searchableDescription: string | null;
  tags: string[];
  tools: string[];
  status: SkillStatus;
  /** Optimistic-concurrency guard carried into publish/edit. */
  version: number;
}

/**
 * An observed tool.
 *
 * Cloud does not own `description`: the definition lives with whoever runs the
 * agent, so it is whatever `listObservedTools` and the synced definitions could
 * recover, and an edit to it stays hypothetical.
 *
 * The RETRIEVAL description is different. A tool the runtime has ingested has a
 * `runtime_catalog_entries` row, and Cloud may replace that row's retrieval text
 * with an operator override — which is a real, savable edit. `entryId` is what
 * makes that possible, and it is null for a tool telemetry has only ever seen
 * called.
 */
export interface BenchTool {
  name: string;
  /** What the agent receives when this tool is retrieved. */
  description: string;
  /**
   * The `runtime_catalog_entries` key, when the runtime has ingested this tool.
   * Null for observed-only tools — which is also what makes a save impossible.
   */
  entryId: string | null;
  /** The runtime's own retrieval text. Null when nothing was ingested. */
  searchableDescription: string | null;
  /** The Cloud-side operator replacement, when one is set. */
  searchableDescriptionOverride: string | null;
  /** False when telemetry knows the tool by name but has no synced definition. */
  hasDefinition: boolean;
  calls: number;
  /** Input tokens attributed to this tool. Estimates, never facts — see below. */
  tokens: number;
  tokensProvenance: DataProvenance;
  costUsd: number;
  costProvenance: DataProvenance;
}

/** One what-if edit. Absent fields mean "unchanged from the baseline". */
export interface CapabilityDraft {
  description?: string;
  tags?: string[];
}

/** Drafts keyed by capability id (skill `name`, tool `name`) within a kind. */
export type DraftsByKind = {
  skill: Record<string, CapabilityDraft>;
  tool: Record<string, CapabilityDraft>;
};

/**
 * How a query is scored. Named for the two things being run (the SDK's BM25
 * index and the embedding model) because that is what the rest of the codebase
 * and the product call them. `lexical`/`semantic` would be a third vocabulary
 * for the same two mechanisms.
 */
export type RankMode = "bm25" | "embeddings" | "hybrid";

export interface RankOptions {
  mode: RankMode;
  topKSkills: number;
  topKTools: number;
  /** Embedding share in `hybrid`, in [0, 1]. Ignored by the other modes. */
  embeddingWeight: number;
}

/** One ranked capability. `score` is comparable only within its own bucket. */
export interface RankedHit {
  id: string;
  kind: CapabilityKind;
  rank: number;
  score: number;
  /** The components behind `score`, shown when the mode blends them. */
  bm25Score: number | null;
  embeddingScore: number | null;
  /**
   * What the agent RECEIVES for this hit: the plain description, never the text
   * it was matched on. The two come from different fields on purpose; collapsing
   * them back into one is the bug this separation exists to prevent.
   */
  description: string;
  /** The text the hit was actually MATCHED on (draft applied when overridden). */
  searchableDescription: string;
  /** Where that match text came from, so the UI can say whose it is. */
  searchableDescriptionSource: SearchableDescriptionSource;
  edited: boolean;
}

/** The two independently-ranked buckets one run produces. */
export interface RankedBuckets {
  skills: RankedHit[];
  tools: RankedHit[];
}
