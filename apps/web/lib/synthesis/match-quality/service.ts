import { and, eq } from "drizzle-orm";
import { loadCatalogInventory } from "@/lib/ingest/runtime-catalog/inventory";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import {
  resolveSearchableDescription,
  searchableDescriptionSource,
} from "@/lib/synthesis/playground/descriptions";

/**
 * The reads a run needs that are not already somebody else's.
 *
 * The corpus is loaded here rather than through `lib/quality/fingerprint.ts`'s
 * inventory because the two want different things from the same table: the
 * fingerprint wants the canonical triple it hashes, and a prompt wants tags and
 * provenance as well. The FINGERPRINT itself still comes from that module, so a
 * run and the quality trend mark themselves against the same corpus identity
 * rather than two hashes that agree until they do not.
 */

export type ServiceDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * The tool catalog as retrieval currently matches on it.
 *
 * Tools only. `searchable_description_override` is the single Cloud-editable
 * field and it exists on every runtime kind, but skills already have their own
 * editing path in the Skills catalog, and facts do not meaningfully compete in
 * tool retrieval. Widening this later is a filter change, not a redesign.
 */
export async function loadToolCorpus(
  projectId: string,
  db: ServiceDb = getDb(),
): Promise<CorpusEntry[]> {
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
    const searchable = resolveSearchableDescription(row);
    return {
      entryId: row.entryId,
      name: row.name,
      searchable,
      description: row.description,
      runtimeSearchable: row.searchableDescription ?? undefined,
      source: searchableDescriptionSource(row),
      matchesAgentDescription: normalize(searchable) === normalize(row.description),
      tags: row.tags ?? [],
    };
  });
}

/** The corpus plus the hash the quality trend marks its change lines against. */
export async function loadCorpusWithFingerprint(
  projectId: string,
  db: ServiceDb = getDb(),
): Promise<{ entries: CorpusEntry[]; fingerprint: string | null }> {
  const [entries, inventory] = await Promise.all([
    loadToolCorpus(projectId, db),
    loadCatalogInventory(projectId, db),
  ]);
  return { entries, fingerprint: inventory.fingerprint };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
