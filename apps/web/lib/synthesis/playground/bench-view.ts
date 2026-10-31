import type { SkillStatus } from "@/lib/catalog/manage";
import type { CatalogProvenance } from "@/lib/ingest/catalogs/vocabulary";
import type { DataProvenance } from "@/lib/synthesis/catalog/provenance";
import { applySkillDraft, applyToolDraft, skillIsEdited, toolIsEdited } from "./bench";
import {
  resolveSearchableDescription,
  type SearchableDescriptionSource,
  searchableDescriptionSource,
  searchableMatchesAgentDescription,
} from "./descriptions";
import type { BenchSkill, BenchTool, CapabilityKind, DraftsByKind } from "./types";

/**
 * Making a catalog of a few hundred capabilities navigable.
 *
 * A real project has ~7 skills and *hundreds* of tools, so the bench cannot be
 * a flat list of open editors. It has to be a searchable, filterable index
 * where a row is one line until you open it. This module is the pure half of
 * that: which rows exist, what they say, and what order they come in.
 */

export type BenchFilter = "all" | "ranked" | "edited" | "undescribed";

export interface BenchEntry {
  id: string;
  kind: CapabilityKind;
  /**
   * The text that would be MATCHED right now, draft applied. This is what the
   * row's editor edits, because it is the only text an edit here can move.
   */
  description: string;
  /**
   * What the agent RECEIVES, which for a managed entry is a different field.
   * Null when it is the same string as `description`, so a surface can say
   * "these are the same" once instead of printing the paragraph twice.
   */
  agentDescription: string | null;
  /** Where the match text comes from, so the row can name its owner. */
  searchableDescriptionSource: SearchableDescriptionSource;
  /**
   * The RUNTIME's own searchable text, before any Cloud override.
   *
   * Carried separately from `description` so the editor can show the layer it
   * is overriding rather than implying the runtime's copy is the thing being
   * typed over — and so clearing the field can fall back to a real value
   * instead of to nothing.
   */
  runtimeDefault: string;
  /**
   * Who owns this row, in the catalog's own three-way vocabulary. Read by the
   * same icon badge the tools catalog uses — a plug for a runtime-managed
   * entry, an eye for one telemetry has merely seen — so the two surfaces say
   * "Ratel-managed" with the same glyph rather than each inventing a phrase.
   */
  provenance: CatalogProvenance;
  edited: boolean;
  /** Rank in the latest run, when this capability placed. */
  rank: number | null;
  /** Tools only: how often telemetry saw it called. */
  calls: number | null;
  /** Tools only: false when no definition has been synced. */
  hasDefinition: boolean;
  /** Skills only. */
  status: SkillStatus | null;
  /**
   * Tools only: the `runtime_catalog_entries` key. Non-null means Cloud may
   * save this entry's searchable description; null means it may not, and the
   * server enforces that either way.
   */
  entryId: string | null;
  /** Tools only. OTel estimates — carried with provenance, never as facts. */
  tokens: number | null;
  tokensProvenance: DataProvenance | null;
  costUsd: number | null;
  costProvenance: DataProvenance | null;
}

/**
 * The agent description, or null when it is the same text as the match.
 *
 * Ingest copies `description` into `searchable_description`, so identical is
 * the DEFAULT rather than the exception. Returning null for that case is what
 * keeps every surface from rendering the same paragraph under two headings.
 */
function agentDescriptionOf(capability: BenchSkill | BenchTool): string | null {
  return searchableMatchesAgentDescription(capability) ? null : capability.description;
}

export function buildSkillEntries(
  skills: readonly BenchSkill[],
  drafts: DraftsByKind,
  ranks: ReadonlyMap<string, number>,
): BenchEntry[] {
  return skills.map((skill) => {
    const draft = drafts.skill[skill.name];
    const drafted = applySkillDraft(skill, draft);
    return {
      id: skill.name,
      kind: "skill" as const,
      description: resolveSearchableDescription(drafted),
      agentDescription: agentDescriptionOf(drafted),
      searchableDescriptionSource: searchableDescriptionSource(drafted),
      runtimeDefault: skill.searchableDescription ?? skill.description,
      edited: skillIsEdited(skill, draft),
      rank: ranks.get(skill.name) ?? null,
      calls: null,
      hasDefinition: true,
      status: skill.status,
      // A skill is Cloud's own row: created here, and the catalog route has
      // always owned the write.
      provenance: "cloud" as const,
      entryId: null,
      tokens: null,
      tokensProvenance: null,
      costUsd: null,
      costProvenance: null,
    };
  });
}

export function buildToolEntries(
  tools: readonly BenchTool[],
  drafts: DraftsByKind,
  ranks: ReadonlyMap<string, number>,
): BenchEntry[] {
  return tools.map((tool) => {
    const draft = drafts.tool[tool.name];
    const drafted = applyToolDraft(tool, draft);
    return {
      id: tool.name,
      kind: "tool" as const,
      description: resolveSearchableDescription(drafted),
      agentDescription: agentDescriptionOf(drafted),
      searchableDescriptionSource: searchableDescriptionSource(drafted),
      // The runtime's own text, never the override: this is what a cleared
      // override falls back to, and what the editor names as the layer below.
      runtimeDefault: tool.searchableDescription ?? tool.description,
      edited: toolIsEdited(tool, draft),
      rank: ranks.get(tool.name) ?? null,
      calls: tool.calls,
      hasDefinition: tool.hasDefinition,
      status: null,
      // A runtime row is what makes a tool editable at all, which is the same
      // rule the tools catalog applies (`lib/catalogs/table-view.ts`).
      provenance: tool.entryId === null ? ("observed" as const) : ("managed" as const),
      entryId: tool.entryId,
      tokens: tool.tokens,
      tokensProvenance: tool.tokensProvenance,
      costUsd: tool.costUsd,
      costProvenance: tool.costProvenance,
    };
  });
}

/** A capability with nothing to match on can never be retrieved. */
export function isUndescribed(entry: BenchEntry): boolean {
  return entry.description.trim() === "";
}

export function matchesFilter(entry: BenchEntry, filter: BenchFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ranked":
      return entry.rank !== null;
    case "edited":
      return entry.edited;
    case "undescribed":
      return isUndescribed(entry);
  }
}

/** Case-insensitive substring over the id and the effective description. */
export function matchesSearch(entry: BenchEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    entry.id.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)
  );
}

/**
 * Ranked first (in rank order), then edited, then the busiest, then by name.
 *
 * Putting the current run's results on top is deliberate: after a run, the rows
 * worth reading are the ones that placed and the ones you just changed. Scanning
 * 200 alphabetical tools to find the three that moved is the failure mode this
 * ordering exists to prevent.
 */
export function compareEntries(a: BenchEntry, b: BenchEntry): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  if (a.edited !== b.edited) return a.edited ? -1 : 1;
  if ((a.calls ?? 0) !== (b.calls ?? 0)) return (b.calls ?? 0) - (a.calls ?? 0);
  return a.id.localeCompare(b.id);
}

export function visibleEntries(
  entries: readonly BenchEntry[],
  options: { search: string; filter: BenchFilter },
): BenchEntry[] {
  return entries
    .filter((entry) => matchesFilter(entry, options.filter) && matchesSearch(entry, options.search))
    .sort(compareEntries);
}

/** How many rows each filter would show, for the filter chips' counts. */
export function filterCounts(entries: readonly BenchEntry[]): Record<BenchFilter, number> {
  return {
    all: entries.length,
    ranked: entries.filter((entry) => entry.rank !== null).length,
    edited: entries.filter((entry) => entry.edited).length,
    undescribed: entries.filter(isUndescribed).length,
  };
}

/** Rank lookup for one run's bucket, keyed by capability id. */
export function ranksById(hits: ReadonlyArray<{ id: string; rank: number }>): Map<string, number> {
  return new Map(hits.map((hit) => [hit.id, hit.rank]));
}

/* Tag editing */

/**
 * Parse a tag input's raw text into tags. Commas and newlines separate; blanks
 * and duplicates are dropped. Kept here so the chips the reader sees and the
 * array the ranker indexes can never disagree.
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export interface BenchGroup {
  key: "results" | "edited" | "rest";
  label: string;
  entries: BenchEntry[];
}

/**
 * The list, banded so there is somewhere obvious to start.
 *
 * A few hundred equally-weighted rows give the reader no entry point, and the
 * answer is not to hide the rest behind a filter: the capability that did NOT
 * rank is exactly what someone debugging retrieval came to find. So nothing is
 * removed, it is ordered and labelled. What placed in the last run comes first,
 * then what you have edited, then the catalog.
 *
 * Bands are emitted only when there is more than one, because a single header
 * over the whole list is a label for nothing.
 */
export function groupEntries(entries: readonly BenchEntry[]): BenchGroup[] {
  const results: BenchEntry[] = [];
  const edited: BenchEntry[] = [];
  const rest: BenchEntry[] = [];
  for (const entry of entries) {
    if (entry.rank !== null) results.push(entry);
    else if (entry.edited) edited.push(entry);
    else rest.push(entry);
  }

  const groups: BenchGroup[] = [];
  if (results.length > 0) {
    groups.push({ key: "results", label: "In results", entries: results });
  }
  if (edited.length > 0) {
    groups.push({ key: "edited", label: "Edited", entries: edited });
  }
  if (rest.length > 0) {
    groups.push({
      key: "rest",
      label: groups.length === 0 ? "" : "Everything else",
      entries: rest,
    });
  }
  return groups.length === 1 ? [{ ...groups[0], label: "" }] : groups;
}

/* Saving a bench edit */

/**
 * What Save can actually do for one row.
 *
 * The rule is not "hide the button": the server decides, and it already does —
 * `setRuntimeCatalogOverride` is a bare UPDATE keyed on
 * `(project_id, kind, entry_id)`, so a tool the runtime never ingested comes
 * back 404. What this decides is what to OFFER and, when the answer is nothing,
 * which sentence explains why. A greyed-out control with no reason is the same
 * dead end as no control at all.
 */
export type BenchSaveAffordance =
  | { kind: "skill"; label: string }
  | { kind: "searchable-description"; label: string }
  | { kind: "blocked"; reason: string };

/**
 * What a Save actually writes for a managed entry.
 *
 * Null clears the Cloud override and hands the text back to the runtime.
 * Emptying the field is the natural way to ask for that, and typing the
 * runtime's own text back means the same thing — storing either as an override
 * would leave a capability matching on nothing, or a duplicate that silently
 * stops tracking the runtime. Mirrors `resolveSave` in the catalog's own
 * detail view; the two surfaces must not disagree about what Save means.
 */
export function resolveOverrideSave(value: string, runtimeDefault: string): string | null {
  if (value.trim() === "") return null;
  if (value === runtimeDefault) return null;
  return value;
}

export interface BenchSaveOptions {
  /** The runtime-catalog write surface is open for this project. */
  canSaveSearchableDescription: boolean;
}

export function saveAffordance(entry: BenchEntry, options: BenchSaveOptions): BenchSaveAffordance {
  // A skill is Cloud's own row; the catalog route has always owned this write.
  if (entry.kind === "skill") {
    return { kind: "skill", label: "Save to catalog" };
  }
  // No runtime row means there is no searchable description to replace. The
  // draft still ranks — experimenting is the point — it just cannot be kept.
  if (entry.entryId === null) {
    return {
      kind: "blocked",
      reason:
        "Test only. Register this tool through the Ratel runtime to save a searchable description for it.",
    };
  }
  if (!options.canSaveSearchableDescription) {
    return {
      kind: "blocked",
      reason:
        "Test only. The runtime catalog API is off for this project, so searchable descriptions can’t be saved yet.",
    };
  }
  return {
    kind: "searchable-description",
    label: "Save searchable description",
  };
}
