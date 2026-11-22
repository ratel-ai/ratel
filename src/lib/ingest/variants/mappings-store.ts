/** The project's variant attribute mappings (RC-869), oldest first: ingest tries them in this order. */
import { and, asc, eq } from "drizzle-orm";
import type { VariantMapping } from "@/lib/ingest/variants/domain/mappings";
import { variantAttributeMappings } from "@/lib/ingest/variants/schema";
import type { getDb } from "@/lib/platform/db/client";

export type VariantMappingsDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

export interface StoredVariantMapping extends VariantMapping {
  id: string;
  createdAt: Date;
}

/** At most this many mappings per project: ingest reads them all for each batch. */
export const MAX_VARIANT_MAPPINGS = 20;

export async function listVariantMappings(
  projectId: string,
  db: Pick<VariantMappingsDb, "select">,
): Promise<StoredVariantMapping[]> {
  return db
    .select({
      id: variantAttributeMappings.id,
      attributeKey: variantAttributeMappings.attributeKey,
      experiment: variantAttributeMappings.experiment,
      createdAt: variantAttributeMappings.createdAt,
    })
    .from(variantAttributeMappings)
    .where(eq(variantAttributeMappings.projectId, projectId))
    .orderBy(asc(variantAttributeMappings.createdAt), asc(variantAttributeMappings.id))
    .limit(MAX_VARIANT_MAPPINGS);
}

/**
 * Save a mapping. A key already mapped takes the new experiment. Returns
 * "full" when the project already has the most mappings and this key is new.
 */
export async function saveVariantMapping(
  projectId: string,
  mapping: VariantMapping,
  createdBy: string,
  db: VariantMappingsDb,
): Promise<"saved" | "full"> {
  const existing = await listVariantMappings(projectId, db);
  const isNew = !existing.some((row) => row.attributeKey === mapping.attributeKey);
  if (isNew && existing.length >= MAX_VARIANT_MAPPINGS) return "full";
  await db
    .insert(variantAttributeMappings)
    .values({ projectId, ...mapping, createdBy })
    .onConflictDoUpdate({
      target: [variantAttributeMappings.projectId, variantAttributeMappings.attributeKey],
      set: { experiment: mapping.experiment },
    });
  return "saved";
}

/** Remove one mapping of this project. False when the project has no such mapping. */
export async function removeVariantMapping(
  projectId: string,
  mappingId: string,
  db: Pick<VariantMappingsDb, "delete">,
): Promise<boolean> {
  const removed = await db
    .delete(variantAttributeMappings)
    .where(
      and(
        eq(variantAttributeMappings.projectId, projectId),
        eq(variantAttributeMappings.id, mappingId),
      ),
    )
    .returning({ id: variantAttributeMappings.id });
  return removed.length > 0;
}
