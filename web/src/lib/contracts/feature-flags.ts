/**
 * The core's feature switches, and the optional port through which an edition decides them
 * (ADR-0004). Each switch has a semantic key; the deployment's configuration (`web/src/config.ts`,
 * `flags.<key>`) may force it on or off. Without the port each switch is that configured value for
 * the whole deployment (in the open-source edition also `experimentalFeatures`). With it, the
 * edition decides each switch for whoever asks, and a forced value still comes first. The core
 * reads them through `featureEnabled` (`lib/platform/experimental-features.ts`), never through the
 * port directly.
 */

/** Every switch the core reads, by its semantic key. */
export const CORE_FLAGS = [
  "evalGate",
  "rankingCatalogDrift",
  "mcpApps",
  "agentsPages",
  "toolRunInsights",
  "focusedConsole",
  // Owner: rstagi. Scorers, dashboards, alerts and Slack delivery. Remove with the stacked
  // flag-removal PR, once on for all users.
  "customMonitoring",
  // Owner: rstagi. RQL, the read-only query language over trace data, and its MCP tools
  // (describe_rql_schema, run_rql, kind sql). Remove with the stacked flag-removal PR, once on
  // for all users.
  "rql",
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
