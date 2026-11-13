import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { runtimeCatalogEntries } from "./schema";

/**
 * The project's catalog as retrieval sees it: a fingerprint of what search matches on,
 * so a change in any reading can be pinned to a change in the corpus, and the tool corpus
 * a judge chooses between.
 *
 * Not `catalog_snapshots.content_hash`, for three reasons: it is keyed per source and
 * overwritten on every sync, so a past corpus is unrecoverable; it covers agent
 * descriptions and schemas that retrieval never reads, so an editorial change would move
 * it without moving ranking; and it is blind to an operator override, which changes
 * ranking without the publisher sending anything at all. This hashes the resolved
 * searchable text, overrides included. The corpus, not the receipt.
 *
 * Two syncs that leave every searchable string identical produce ONE fingerprint. That is
 * the intent: the count of distinct fingerprints is the number of times retrieval could
 * genuinely have behaved differently.
 *
 * Owned (ADR-0030): the read half of upstream's quality fingerprint and the corpus
 * loader of its match-quality service, in the layer that owns the table. Recording
 * fingerprints over time stays with the quality reading.
 */

/** One entry as the fingerprint hashes it. */
export interface CatalogInventoryEntry {
  kind: string;
  entryId: string;
  name: string;
  searchable: string;
}

/** The corpus, canonicalized: sorted, whitespace-normalized, nothing else. */
export function canonicalEntries(rows: readonly CatalogInventoryEntry[]): CatalogInventoryEntry[] {
  return rows
    .map((row) => ({
      kind: row.kind,
      entryId: row.entryId,
      name: row.name,
      searchable: normalize(row.searchable),
    }))
    .sort((left, right) => compare(left.kind, right.kind) || compare(left.entryId, right.entryId));
}

/**
 * Whitespace is normalized before hashing because a reflowed paragraph is not a different
 * corpus: BM25 tokenizes on word boundaries, so re-wrapping the same sentence cannot
 * change a single score.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The fingerprint of a corpus. Stable under input ordering and re-wrapping. */
export function fingerprintOf(rows: readonly CatalogInventoryEntry[]): string {
  const canonical = canonicalEntries(rows);
  const hash = createHash("sha256");
  for (const entry of canonical) {
    // Length-prefixed so no arrangement of separators inside a description can forge a
    // different corpus that hashes the same.
    const fields = [entry.kind, entry.entryId, entry.name, entry.searchable];
    for (const field of fields) {
      hash.update(`${field.length} ${field} `);
    }
  }
  return hash.digest("hex");
}

/** What an operator wants to know about the corpus behind a reading. */
export interface CatalogInventory {
  fingerprint: string;
  entryCount: number;
  searchableChars: number;
  /** Entries carrying an operator override. */
  overriddenCount: number;
  /** Entries whose searchable text differs from the agent description. */
  distinctCount: number;
  entries: CatalogInventoryEntry[];
}

export interface InventorySourceRow {
  kind: string;
  entryId: string;
  name: string;
  description: string;
  searchableDescription: string | null;
  searchableDescriptionOverride: string | null;
}

type SearchableSource = "override" | "runtime" | "description";

/** Where the text search matches on came from, in the runtime's own precedence. */
function searchableSource(
  row: Pick<InventorySourceRow, "searchableDescription" | "searchableDescriptionOverride">,
): SearchableSource {
  if (row.searchableDescriptionOverride != null) return "override";
  if (row.searchableDescription != null) return "runtime";
  return "description";
}

/** The text search matches on: the override, else the runtime's text, else the description. */
function resolveSearchable(
  row: Pick<
    InventorySourceRow,
    "description" | "searchableDescription" | "searchableDescriptionOverride"
  >,
): string {
  return row.searchableDescriptionOverride ?? row.searchableDescription ?? row.description;
}

/** Summarize a project's corpus: the hash plus the counts shown beside it. */
export function inventoryOf(rows: readonly InventorySourceRow[]): CatalogInventory {
  const entries: CatalogInventoryEntry[] = [];
  let overriddenCount = 0;
  let distinctCount = 0;

  for (const row of rows) {
    const searchable = resolveSearchable(row);
    if (searchableSource(row) === "override") overriddenCount += 1;
    if (normalize(searchable) !== normalize(row.description)) distinctCount += 1;
    entries.push({ kind: row.kind, entryId: row.entryId, name: row.name, searchable });
  }

  const canonical = canonicalEntries(entries);
  return {
    fingerprint: fingerprintOf(canonical),
    entryCount: canonical.length,
    searchableChars: canonical.reduce((total, entry) => total + entry.searchable.length, 0),
    overriddenCount,
    distinctCount,
    entries: canonical,
  };
}

export type InventoryDb = Pick<ReturnType<typeof getDb>, "select">;

/** Read a project's live corpus as retrieval sees it. */
export async function loadCatalogInventory(
  projectId: string,
  db: InventoryDb = getDb(),
): Promise<CatalogInventory> {
  const rows = await db
    .select({
      kind: runtimeCatalogEntries.kind,
      entryId: runtimeCatalogEntries.entryId,
      name: runtimeCatalogEntries.name,
      description: runtimeCatalogEntries.description,
      searchableDescription: runtimeCatalogEntries.searchableDescription,
      searchableDescriptionOverride: runtimeCatalogEntries.searchableDescriptionOverride,
    })
    .from(runtimeCatalogEntries)
    .where(eq(runtimeCatalogEntries.projectId, projectId));

  return inventoryOf(rows);
}

/** One catalog tool as a judge chooses between them (the shape `readings/decisions/judge.ts` reads). */
export interface ToolCorpusEntry {
  entryId: string;
  name: string;
  searchable: string;
  description: string;
  /** The searchable text the project's SDK sent, before any override. */
  runtimeSearchable?: string;
  source: SearchableSource;
  /** True when the searchable text is the agent description verbatim. */
  matchesAgentDescription: boolean;
  tags: string[];
}

/**
 * The tool catalog as retrieval currently matches on it.
 *
 * Tools only. The searchable-text override exists on every runtime kind, but skills have
 * their own editing path in the skills catalog, and facts do not meaningfully compete in
 * tool retrieval. Widening this later is a filter change, not a redesign.
 */
export async function loadToolCorpus(
  projectId: string,
  db: InventoryDb = getDb(),
): Promise<ToolCorpusEntry[]> {
  const rows = await db
    .select({
      entryId: runtimeCatalogEntries.entryId,
      name: runtimeCatalogEntries.name,
      description: runtimeCatalogEntries.description,
      tags: runtimeCatalogEntries.tags,
      searchableDescription: runtimeCatalogEntries.searchableDescription,
      searchableDescriptionOverride: runtimeCatalogEntries.searchableDescriptionOverride,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(eq(runtimeCatalogEntries.projectId, projectId), eq(runtimeCatalogEntries.kind, "tool")),
    );

  return rows.map((row) => {
    const searchable = resolveSearchable(row);
    return {
      entryId: row.entryId,
      name: row.name,
      searchable,
      description: row.description,
      runtimeSearchable: row.searchableDescription ?? undefined,
      source: searchableSource(row),
      matchesAgentDescription: normalize(searchable) === normalize(row.description),
      tags: row.tags ?? [],
    };
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
