import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import { getRetrievalDescriptionAdoption } from "@/lib/ingest/runtime-catalog/adoption";
import type { SearchableOrigin, SearchableState, SearchableTarget } from "./items";

/**
 * What saving a searchable description writes, decided once for every place
 * it can be edited (the tree's detail, the tools Panel, the skills Panel).
 *
 * Two stores sit behind the one field:
 * - a runtime entry (a managed tool or skill) keeps the runtime's text and a
 *   Cloud copy over it (`PATCH /api/runtime-catalog/<kind>/<entryId>`);
 * - a Cloud skill keeps its own text, or none to be matched on its
 *   description (`PATCH /api/skills-catalog/<id>`).
 * Either way, an emptied field or text identical to what applies without a
 * copy stores nothing, so no duplicate silently stops tracking its source.
 */

export type SavePlan =
  | { type: "noop" }
  | { type: "invalid"; error: string }
  /** `stored` is what to write (null clears), `previous` what Undo writes back. */
  | { type: "write"; stored: string | null; previous: string | null };

/** The value stored right now behind a searchable description. */
export function storedValue(target: SearchableTarget): string | null {
  return target.type === "runtime" ? target.override : target.stored;
}

/** The text that applies when nothing is stored: the runtime's, or the skill's description. */
export function fallbackText(target: SearchableTarget, agentDescription: string): string {
  return target.type === "runtime" ? target.runtimeText : agentDescription;
}

export function planSearchableSave(
  target: SearchableTarget,
  agentDescription: string,
  draft: string,
): SavePlan {
  const text = draft.trim();
  const stored =
    text === "" || text === fallbackText(target, agentDescription).trim() ? null : text;
  if (stored !== null && stored.length > MAX_DESCRIPTION) {
    return {
      type: "invalid",
      error: `Keep it under ${MAX_DESCRIPTION.toLocaleString("en-US")} characters.`,
    };
  }
  const previous = storedValue(target);
  if (stored === previous) return { type: "noop" };
  return { type: "write", stored, previous };
}

/** Clearing the Cloud copy of a runtime entry, so the runtime's text applies again. */
export function planSearchableReset(target: SearchableTarget): SavePlan {
  const previous = storedValue(target);
  return target.type === "runtime" && previous !== null
    ? { type: "write", stored: null, previous }
    : { type: "noop" };
}

/** The target as it stands after a write, so Undo and the next edit start from it. */
export function targetAfterWrite(
  target: SearchableTarget,
  stored: string | null,
  version?: number,
): SearchableTarget {
  return target.type === "runtime"
    ? { ...target, override: stored }
    : { ...target, stored, version: version ?? target.version };
}

/** One quiet line about where the text comes from. The agent case is said by the agent description itself. */
export const SEARCHABLE_ORIGIN_NOTE: Record<SearchableOrigin, string | null> = {
  cloud: "Set here in Cloud.",
  runtime: "From your runtime.",
  agent: null,
};

/** True when the agent receives exactly the text it is matched on. */
export function matchesAgentDescription(
  searchable: SearchableState,
  agentDescription: string | null,
): boolean {
  return agentDescription !== null && searchable.text.trim() === agentDescription.trim();
}

export type AdoptionNotice = "still-own-copy" | "may-use-own-copy";

/**
 * Whether to say that a Cloud copy has not reached the runtime yet, claimed
 * only as far as the evidence goes (see `CatalogAdoptionWarning`). Tools count
 * a recent override pull or the runtime's own flag as proof; skills use the
 * catalog version evidence, which can also prove the opposite.
 */
export function adoptionNotice(
  searchable: SearchableState,
  adopted: boolean | null,
): AdoptionNotice | null {
  const target = searchable.target;
  if (target.type !== "runtime" || target.override === null) return null;
  const reports: boolean | null =
    target.kind === "tool"
      ? adopted === true || target.useCloudDefinitions
        ? true
        : null
      : adopted;
  const adoption = getRetrievalDescriptionAdoption({
    searchableDescription: target.runtimeText,
    searchableDescriptionOverride: target.override,
    useCloudDefinitions: reports === true,
  });
  if (adoption === "in-sync" || reports === true) return null;
  return reports === false ? "still-own-copy" : "may-use-own-copy";
}
