/**
 * The core's feature switches, and the optional port through which an edition decides them
 * (ADR-0030). Without the port each switch is its `FF_*` environment variable for the whole
 * deployment (in the open-source edition also `RATEL_EXPERIMENTAL_FEATURES`). With it, the
 * edition decides each switch for whoever asks, and an `FF_*` value set in the environment
 * still comes first. The core reads them through `featureEnabled`
 * (`lib/platform/experimental-features.ts`), never through the port directly.
 */

/** Every switch the core reads, by its environment name. */
export const CORE_FLAGS = [
  "FF_EVAL_GATE",
  "FF_RANKING_CATALOG_DRIFT",
  "FF_MCP_APPS",
  "FF_AGENTS_PAGES",
  "FF_TOOL_RUN_INSIGHTS",
  "FF_TYPED_STEPS",
] as const;

export type CoreFlag = (typeof CORE_FLAGS)[number];

/** Who asks. Each part is optional: a background job knows its project only. */
export type FlagSubject = {
  organizationId?: string;
  projectId?: string;
  /** The person or key that acts: a user's identity-provider id, or `project:<id>` for a key. */
  actor?: string;
};

export type FeatureFlagsPort = {
  /**
   * Whether a switch is on for this subject. It may reject: the core then treats the switch as
   * off (fail closed).
   */
  enabled(flag: CoreFlag, subject: FlagSubject): Promise<boolean>;
};
