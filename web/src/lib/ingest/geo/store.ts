import { eq, sql } from "drizzle-orm";
import { DEFAULT_GEO_ATTRIBUTES, type GeoAttributes } from "@/lib/ingest/geo/attributes";
import { projectGeoAttributes } from "@/lib/ingest/geo/schema";
import { getDb } from "@/lib/platform/db/client";

export type GeoDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export async function loadGeoAttributes(
  projectId: string,
  db: Pick<GeoDb, "select"> = getDb(),
): Promise<GeoAttributes> {
  const [row] = await db
    .select({
      address: projectGeoAttributes.address,
      country: projectGeoAttributes.country,
      region: projectGeoAttributes.region,
      latitude: projectGeoAttributes.latitude,
      longitude: projectGeoAttributes.longitude,
    })
    .from(projectGeoAttributes)
    .where(eq(projectGeoAttributes.projectId, projectId));
  return row ?? DEFAULT_GEO_ATTRIBUTES;
}

/** Traces received from now on are read under these names. */
export async function saveGeoAttributes(
  projectId: string,
  attributes: GeoAttributes,
  db: Pick<GeoDb, "insert"> = getDb(),
): Promise<void> {
  await db
    .insert(projectGeoAttributes)
    .values({ projectId, ...attributes })
    .onConflictDoUpdate({
      target: projectGeoAttributes.projectId,
      set: { ...attributes, updatedAt: sql`now()` },
    });
}
