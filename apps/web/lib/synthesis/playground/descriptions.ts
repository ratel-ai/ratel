/**
 * The two descriptions a capability carries, and which one retrieval uses.
 *
 * Ratel deliberately matches a prompt against one text and hands a different
 * one back to the agent. Retrieval reads the RETRIEVAL DESCRIPTION —
 * `runtime_catalog_entries.searchable_description`, replaced by
 * `searchable_description_override` when an operator has set one, and
 * `skills.searchable_description` for skills. What the agent then receives is
 * the plain `description`.
 *
 * Ingest copies `description` into `searchable_description` by default
 * (`lib/catalogs/queries.ts`), so in most projects the two are the same string.
 * That is exactly why this resolution lives in one leaf module: when they are
 * NOT the same, every surface has to agree about which one is being scored, and
 * a second copy of this precedence would be a silent disagreement with the
 * product rather than a failing test.
 *
 * The words for the two are decided once in `lib/catalogs/vocabulary.ts`
 * ("Searchable description" / "Agent description"). This module resolves which
 * text applies; that one names them. Neither invents a third phrasing.
 */

/** The description fields any bench capability carries. */
export interface DescribedCapability {
  /** What the agent receives. Cloud does not own this for tools. */
  description: string;
  /** The runtime's own retrieval text. Null when none was ingested. */
  searchableDescription?: string | null;
  /** The Cloud-side operator replacement, when one is set. */
  searchableDescriptionOverride?: string | null;
}

/**
 * Where the text a prompt was matched on came from.
 *
 * `description` means there is no separate retrieval text at all, so the two
 * descriptions are one field and a surface must say that once rather than
 * printing the same paragraph twice.
 */
export type SearchableDescriptionSource = "override" | "runtime" | "description";

export function searchableDescriptionSource(
  capability: DescribedCapability,
): SearchableDescriptionSource {
  if (capability.searchableDescriptionOverride != null) return "override";
  if (capability.searchableDescription != null) return "runtime";
  return "description";
}

/** The text a prompt is matched against, in the runtime's own precedence. */
export function resolveSearchableDescription(capability: DescribedCapability): string {
  return (
    capability.searchableDescriptionOverride ??
    capability.searchableDescription ??
    capability.description
  );
}

/**
 * Whether a capability keeps its retrieval text somewhere other than
 * `description`.
 *
 * This is what decides where a what-if edit lands: a managed entry's edit
 * changes the searchable description (which is savable), while an observed-only
 * tool has exactly one text and an edit changes that. Either way the edit
 * always changes the text retrieval reads, which is the whole point of the
 * bench.
 */
export function hasOwnSearchableDescription(capability: DescribedCapability): boolean {
  return searchableDescriptionSource(capability) !== "description";
}

/**
 * True when the agent would receive exactly the text it was matched on.
 *
 * Compared trimmed, for the same reason the bench compares drafts trimmed: a
 * trailing newline from a snapshot is not a second description.
 */
export function searchableMatchesAgentDescription(capability: DescribedCapability): boolean {
  return resolveSearchableDescription(capability).trim() === capability.description.trim();
}
