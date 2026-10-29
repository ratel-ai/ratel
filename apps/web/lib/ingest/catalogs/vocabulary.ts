/**
 * The catalog's user-facing words, defined once.
 *
 * Ratel indexes a capability on one piece of text and returns a different one.
 * That distinction is the whole point of the catalog UI, and before this module
 * existed every screen invented its own phrasing for it: "retrieval
 * description" in the modal, "searchable description" on the wire, "search
 * text" in a draft spec. The same field read as three different concepts
 * depending on where you stood.
 *
 * Labels live here so the tools catalog, the edit modal, the skills catalog and
 * the Playground cannot drift. This is a presentation layer only: DB columns,
 * API fields and TypeScript types keep their existing names, and
 * `searchableDescription` stays the wire name.
 */

/** Which side of the match-vs-return split a piece of text sits on. */
export type CatalogDescriptionRole = "searchable" | "agent";

export type CatalogTerm = {
  /** Short form, for labels and column headers. */
  label: string;
  /** One line, short enough to sit under the label on a row. */
  hint: string;
};

export const CATALOG_DESCRIPTIONS: Record<CatalogDescriptionRole, CatalogTerm> = {
  searchable: {
    label: "Searchable description",
    hint: "What we match prompts against. The agent never sees this.",
  },
  agent: {
    label: "Agent description",
    hint: "What we hand back to the agent when this capability is retrieved.",
  },
};

/**
 * Shown when one string is doing both jobs, which is the ingest default. The
 * two role icons sit beside it, so the sentence only has to confirm what the
 * icons already say.
 */
export const CATALOG_DESCRIPTIONS_SAME = "Same text used for both.";

/** Heading for the merged block, when one string serves both roles. */
export const CATALOG_DESCRIPTIONS_SAME_LABEL = "Searchable and agent description";

/* ------------------------------ editing state ----------------------------- */

/**
 * Where the searchable text currently comes from.
 *
 * Two layers, and only two. Your runtime always reports a searchable
 * description: when the SDK caller does not supply one it reports the tool's
 * own description and flags that it was not customised. Cloud may then set an
 * override, which wins while it exists and is never touched by re-ingest.
 * There is no stored-but-inactive state, so nothing here is a toggle.
 */
export const CATALOG_SEARCHABLE_SOURCE = {
  runtime: {
    label: "Runtime default",
    hint: "Your runtime supplies this text. Override it to have Cloud own it instead.",
  },
  cloud: {
    label: "Cloud override",
    hint: "Cloud supplies this text, replacing whatever the runtime sent. Re-ingest never overwrites it.",
  },
} as const;

export const CATALOG_OVERRIDE_ACTION = "Override in Cloud";
export const CATALOG_RESET_ACTION = "Reset to runtime default";
export const CATALOG_MATCH_AGENT_ACTION = "Match the agent description";

/** Why the reset button and an emptied field do the same thing. */
export const CATALOG_EMPTY_RESETS =
  "Clearing the field and saving removes the Cloud override, so the runtime's text applies again.";

/**
 * The whole story, for a help popover. Three layers is one more than most
 * readers will hold in their head from labels alone, so it gets written down
 * somewhere they can reach without leaving the modal.
 */
export const CATALOG_LAYERS_HELP: readonly { title: string; body: string }[] = [
  {
    title: "Agent description",
    body: "Comes from your runtime and is read-only here. This is what the agent receives when the capability is retrieved.",
  },
  {
    title: "Runtime default",
    body: "The text your runtime reports for matching. If the SDK caller did not set one, it is a copy of the agent description.",
  },
  {
    title: "Cloud override",
    body: "An optional replacement you set here. While it exists it wins over the runtime's text, and re-ingest never clears it.",
  },
];

/**
 * Offered when the runtime set a custom searchable description you would rather
 * not match on. There is no "no searchable description" state to fall back to
 * for a tool, so pointing the override at the agent description is how you say
 * "just match on what the agent sees".
 */
export const CATALOG_MATCH_AGENT_HELP =
  "Search on the agent description instead of the runtime's custom text.";

/* ------------------------------- provenance ------------------------------- */

/** Where a catalog row's definition came from, and therefore who may edit it. */
export type CatalogProvenance = "cloud" | "managed" | "observed";

export type CatalogProvenanceTerm = CatalogTerm & {
  /**
   * The long form, used as the accessible name and tooltip. Icons carry the
   * meaning visually; this is what a screen reader announces.
   */
  description: string;
  /** Whether Cloud can write anything on this row at all. */
  editable: boolean;
};

export const CATALOG_PROVENANCE: Record<CatalogProvenance, CatalogProvenanceTerm> = {
  cloud: {
    label: "Cloud",
    description: "Cloud-authored: created here, so Cloud owns every field.",
    hint: "Created in Ratel Cloud.",
    editable: true,
  },
  managed: {
    label: "Ratel-managed",
    description:
      "Managed by the Ratel runtime: the definition is synced from your runtime, and only the searchable description is editable here.",
    hint: "Synced from your runtime.",
    editable: true,
  },
  observed: {
    label: "Observed",
    description:
      "Observed only: seen in telemetry but never registered, so there is no definition to show or edit.",
    hint: "Seen in telemetry only.",
    editable: false,
  },
};

export const CATALOG_PROVENANCE_ORDER: readonly CatalogProvenance[] = [
  "managed",
  "cloud",
  "observed",
];

/* -------------------------------- staleness ------------------------------- */

/**
 * Days of silence before `listSyncedTools` marks a source stale. The label
 * below has to state the number, so it cannot be a magic constant on the UI
 * side; `lib/catalogs/queries.ts` imports it rather than restating it, because
 * the two drifting is exactly how a badge starts describing the wrong window.
 */
export const CATALOG_STALE_DAYS = 7;

/**
 * Days of silence before a source stops counting at all: `listSyncedTools`
 * drops it from the table, and `replaceCatalogSnapshot` stops treating its
 * definitions as evidence a tool still exists. One number for both, so a
 * source cannot be invisible in the UI while still pinning entries alive.
 */
export const CATALOG_INACTIVE_DAYS = 30;

export const CATALOG_STALE: CatalogTerm = {
  label: `Not synced · ${CATALOG_STALE_DAYS}d`,
  hint: `This tool's source hasn't sent events or a catalog snapshot in ${CATALOG_STALE_DAYS} days.`,
};

/* --------------------------------- metrics -------------------------------- */

/**
 * Column copy for the two telemetry-derived metrics. Both are reconstructed
 * from OpenTelemetry rather than counted, so the wording has to stay hedged.
 * `PartialDataValue` renders them behind a `≈`.
 */
export const CATALOG_METRICS = {
  calls: {
    facts: "Call count from direct runtime facts.",
    otel: "Approximate call count reconstructed from OpenTelemetry.",
    absent: "No call count was reported.",
  },
  tokens: {
    label: "Input tokens",
    hint: "Approximate input tokens reconstructed from OpenTelemetry.",
    absent:
      "No telemetry has been observed for this tool yet, so there are no input tokens to attribute.",
  },
  cost: {
    label: "Cost",
    hint: "Approximate cost attributed from OpenTelemetry by input-token share.",
    absent: "No telemetry has been observed for this tool yet, so there is no cost to attribute.",
  },
} as const;

/**
 * Shown in place of the metric columns when no row on the page has telemetry.
 * A grid of dashes reads as a broken table; saying why reads as an empty one.
 */
export const CATALOG_METRICS_UNOBSERVED =
  "No usage telemetry yet. Tools appear here from their definitions, and usage fills in once they are called.";
