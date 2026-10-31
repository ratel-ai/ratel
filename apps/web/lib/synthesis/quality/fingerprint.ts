import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  resolveSearchableDescription,
  searchableDescriptionSource,
} from "@/lib/synthesis/playground/descriptions";
import type { CatalogFingerprintEntry } from "@/lib/synthesis/quality/schema";
import { catalogFingerprints } from "@/lib/synthesis/quality/schema";

/**
 * A hash of what retrieval actually matches on, so a change in quality can be
 * pinned to a change in the corpus.
 *
 * Not `catalog_snapshots.content_hash`, for three reasons: it is keyed per
 * source and overwritten on every sync, so a past corpus is unrecoverable; it
 * covers agent descriptions and schemas that retrieval never reads, so an
 * editorial change would move it without moving ranking; and it is blind to a
 * Cloud-side override, which changes ranking without the publisher sending
 * anything at all. This hashes the resolved searchable text, overrides
 * included. The corpus, not the receipt.
 *
 * The consequence worth stating: two syncs that leave every searchable string
 * identical produce ONE fingerprint. That is the intent. The row count is the
 * number of times retrieval could genuinely have behaved differently, which is
 * what the trend chart marks its change lines against.
 */

/** The corpus, canonicalized: sorted, whitespace-normalized, nothing else. */
export function canonicalEntries(
  rows: readonly CatalogFingerprintEntry[],
): CatalogFingerprintEntry[] {
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
 * Whitespace is normalized before hashing because a reflowed paragraph is not a
 * different corpus: BM25 tokenizes on word boundaries, so re-wrapping the same
 * sentence cannot change a single score. Leaving it in would spray fingerprint
 * rows across the trend for edits that provably did nothing.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The fingerprint of a corpus. Stable under input ordering and re-wrapping. */
export function fingerprintOf(rows: readonly CatalogFingerprintEntry[]): string {
  const canonical = canonicalEntries(rows);
  const hash = createHash("sha256");
  for (const entry of canonical) {
    // Length-prefixed so no arrangement of separators inside a description can
    // forge a different corpus that hashes the same.
    const fields = [entry.kind, entry.entryId, entry.name, entry.searchable];
    for (const field of fields) {
      hash.update(`${field.length} ${field} `);
    }
  }
  return hash.digest("hex");
}

/** What an operator wants to know about the corpus behind a quality number. */
export interface CatalogInventory {
  fingerprint: string;
  entryCount: number;
  searchableChars: number;
  /** Entries carrying a Cloud-side operator override. */
  overriddenCount: number;
  /** Entries whose searchable text differs from the agent description. */
  distinctCount: number;
  entries: CatalogFingerprintEntry[];
}

export interface FingerprintSourceRow {
  kind: string;
  entryId: string;
  name: string;
  description: string;
  searchableDescription: string | null;
  searchableDescriptionOverride: string | null;
}

/** Summarize a project's corpus: the hash plus the counts shown beside it. */
export function inventoryOf(rows: readonly FingerprintSourceRow[]): CatalogInventory {
  const entries: CatalogFingerprintEntry[] = [];
  let overriddenCount = 0;
  let distinctCount = 0;

  for (const row of rows) {
    const searchable = resolveSearchableDescription(row);
    if (searchableDescriptionSource(row) === "override") overriddenCount += 1;
    if (normalize(searchable) !== normalize(row.description)) distinctCount += 1;
    entries.push({
      kind: row.kind,
      entryId: row.entryId,
      name: row.name,
      searchable,
    });
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

export type FingerprintDb = ReturnType<typeof getDb>;

/** Read a project's live corpus as retrieval sees it. */
export async function loadCatalogInventory(
  projectId: string,
  db: Pick<FingerprintDb, "select"> = getDb(),
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

/**
 * Record the current corpus, or touch the existing row when nothing changed.
 *
 * Returns whether this corpus is new, which is the "trigger when the catalog
 * hash changes" signal: a caller that only wants to act on real change can read
 * `changed` rather than re-deriving the comparison itself.
 */
export async function recordCatalogFingerprint(
  projectId: string,
  db: Pick<FingerprintDb, "select" | "insert"> = getDb(),
  now: Date = new Date(),
): Promise<{ inventory: CatalogInventory; changed: boolean }> {
  const inventory = await loadCatalogInventory(projectId, db);

  const [existing] = await db
    .select({ fingerprint: catalogFingerprints.fingerprint })
    .from(catalogFingerprints)
    .where(
      and(
        eq(catalogFingerprints.projectId, projectId),
        eq(catalogFingerprints.fingerprint, inventory.fingerprint),
      ),
    )
    .limit(1);

  await db
    .insert(catalogFingerprints)
    .values({
      projectId,
      fingerprint: inventory.fingerprint,
      entryCount: inventory.entryCount,
      searchableChars: inventory.searchableChars,
      overriddenCount: inventory.overriddenCount,
      distinctCount: inventory.distinctCount,
      entries: inventory.entries,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [catalogFingerprints.projectId, catalogFingerprints.fingerprint],
      // Only `last_seen_at` moves. `first_seen_at` is where the trend chart
      // draws its change line, so re-syncing an unchanged corpus must never
      // push that line forward.
      set: { lastSeenAt: now },
    });

  return { inventory, changed: existing === undefined };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
