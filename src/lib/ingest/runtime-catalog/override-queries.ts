import { and, asc, eq, isNotNull } from "drizzle-orm";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";

/** Runtime-catalog override pulls and edits (owned fragment of the upstream queries hub). */

/** Note that a runtime fetched this project's overrides. Best-effort; never fails the pull. */
export async function touchRuntimeCatalogOverridesPull(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "update"> = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db.update(projects).set({ overridesPulledAt: now }).where(eq(projects.id, projectId));
}

/** Set or clear the operator override for an already-ingested runtime entry. */
export async function setRuntimeCatalogOverride(
  projectId: string,
  kind: string,
  entryId: string,
  searchableDescription: string | null,
  db: Pick<ReturnType<typeof getDb>, "update"> = getDb(),
): Promise<{ searchableDescriptionOverride: string | null } | null> {
  const [row] = await db
    .update(runtimeCatalogEntries)
    .set({ searchableDescriptionOverride: searchableDescription })
    .where(
      and(
        eq(runtimeCatalogEntries.projectId, projectId),
        eq(runtimeCatalogEntries.kind, kind),
        eq(runtimeCatalogEntries.entryId, entryId),
      ),
    )
    .returning({
      searchableDescriptionOverride: runtimeCatalogEntries.searchableDescriptionOverride,
    });
  return row ?? null;
}

/** List the Cloud-side runtime overrides in stable wire order. */
export async function listRuntimeCatalogOverrides(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<{ kind: string; entryId: string; searchableDescription: string }[]> {
  const rows = await db
    .select({
      kind: runtimeCatalogEntries.kind,
      entryId: runtimeCatalogEntries.entryId,
      searchableDescription: runtimeCatalogEntries.searchableDescriptionOverride,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(
        eq(runtimeCatalogEntries.projectId, projectId),
        isNotNull(runtimeCatalogEntries.searchableDescriptionOverride),
      ),
    )
    .orderBy(asc(runtimeCatalogEntries.kind), asc(runtimeCatalogEntries.entryId));
  return rows.map((row) => ({
    kind: row.kind,
    entryId: row.entryId,
    searchableDescription: row.searchableDescription as string,
  }));
}
