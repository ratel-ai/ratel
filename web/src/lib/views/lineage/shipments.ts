import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { matchQualityProposals } from "@/lib/synthesis/match-quality/schema";
import { fixShipments } from "@/lib/views/fixes/schema";
import { lineageLinks } from "@/lib/views/lineage/schema";
import { appliedRewriteShipmentId, fixRef, withHref } from "./refs";
import { isLineageStage, type LineageRef } from "./types";

/**
 * Ship's list (RC-45): what went live, newest first, each with the fix it came
 * from. Today that is every applied description rewrite (the one change Cloud
 * makes itself) plus any shipment a producer recorded in `lineage_links`
 * (RC-43's `mark_fix_shipped`). RC-53 brings releases; until then a project
 * with neither sees Ship's empty state.
 *
 * A shipment `mark_fix_shipped` recorded has a `fix_shipments` row: its title
 * then names the fix (as the experiment → fix link recorded it, when the
 * shipment came through an experiment) and the version it shipped in.
 */

export type ShipmentsDb = Pick<ReturnType<typeof getDb>, "select">;

export interface ShipmentRow {
  ref: LineageRef;
  /** What changed, in plain words. */
  title: string;
  /** ISO time it went live (applied, or recorded). */
  shippedAt: string;
  source: LineageRef | null;
}

/** The newest this many of each kind. */
const LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The version and fix label of each MCP-recorded shipment (`fix_shipments`), by shipment id. */
async function recordedReleases(
  db: ShipmentsDb,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, { version: string; fixLabel: string | null }>> {
  const uuids = ids.filter((id) => UUID.test(id));
  const out = new Map<string, { version: string; fixLabel: string | null }>();
  if (uuids.length === 0) return out;
  const shipped = await db
    .select({ id: fixShipments.id, fixId: fixShipments.fixId, version: fixShipments.version })
    .from(fixShipments)
    .where(and(eq(fixShipments.projectId, projectId), inArray(fixShipments.id, uuids)));
  if (shipped.length === 0) return out;
  const fixIds = [...new Set(shipped.map((row) => row.fixId))];
  const labels = await db
    .select({
      kind: lineageLinks.kind,
      sourceId: lineageLinks.sourceId,
      sourceLabel: lineageLinks.sourceLabel,
    })
    .from(lineageLinks)
    .where(
      and(
        eq(lineageLinks.projectId, projectId),
        eq(lineageLinks.sourceKind, "fix"),
        inArray(lineageLinks.sourceId, fixIds),
      ),
    );
  // The fix's title as the loop recorded it (experiment or shipment → fix); an eval names it by its short form.
  const labelOf = new Map<string, string>();
  for (const row of [...labels].sort(
    (a, b) => Number(a.kind === "eval") - Number(b.kind === "eval"),
  )) {
    if (row.sourceLabel && !labelOf.has(row.sourceId)) labelOf.set(row.sourceId, row.sourceLabel);
  }
  for (const row of shipped)
    out.set(row.id, { version: row.version, fixLabel: labelOf.get(row.fixId) ?? null });
  return out;
}

export async function loadShipments(
  projectId: string,
  db: ShipmentsDb = getDb(),
): Promise<ShipmentRow[]> {
  const [rewrites, recorded] = await Promise.all([
    db
      .select({
        id: matchQualityProposals.id,
        entryName: matchQualityProposals.entryName,
        appliedAt: matchQualityProposals.appliedAt,
        updatedAt: matchQualityProposals.updatedAt,
      })
      .from(matchQualityProposals)
      .where(
        and(
          eq(matchQualityProposals.projectId, projectId),
          eq(matchQualityProposals.status, "applied"),
        ),
      )
      .orderBy(desc(matchQualityProposals.appliedAt))
      .limit(LIMIT),
    db
      .select({
        objectId: lineageLinks.objectId,
        sourceStage: lineageLinks.sourceStage,
        sourceKind: lineageLinks.sourceKind,
        sourceId: lineageLinks.sourceId,
        sourceLabel: lineageLinks.sourceLabel,
        createdAt: lineageLinks.createdAt,
      })
      .from(lineageLinks)
      .where(
        and(
          eq(lineageLinks.projectId, projectId),
          eq(lineageLinks.stage, "ship"),
          eq(lineageLinks.kind, "shipment"),
        ),
      )
      .orderBy(desc(lineageLinks.createdAt))
      .limit(LIMIT),
  ]);

  const releases = await recordedReleases(
    db,
    projectId,
    recorded.map((link) => link.objectId),
  );
  const rows = new Map<string, ShipmentRow>();
  for (const rewrite of rewrites) {
    const id = appliedRewriteShipmentId(rewrite.id);
    const title = `Searchable description of ${rewrite.entryName} updated`;
    rows.set(id, {
      ref: withHref({ stage: "ship", kind: "shipment", id, label: title }, projectId),
      title,
      shippedAt: (rewrite.appliedAt ?? rewrite.updatedAt).toISOString(),
      source: withHref(
        fixRef(id, `Rewrite ${rewrite.entryName}'s searchable description`),
        projectId,
      ),
    });
  }
  for (const link of recorded) {
    const existing = rows.get(link.objectId);
    const source: LineageRef | null = isLineageStage(link.sourceStage)
      ? withHref(
          {
            stage: link.sourceStage,
            kind: link.sourceKind,
            id: link.sourceId,
            ...(link.sourceLabel ? { label: link.sourceLabel } : {}),
          },
          projectId,
        )
      : null;
    if (existing) {
      // A recorded link names the source more precisely than the derived one.
      if (source) existing.source = source;
      continue;
    }
    const release = releases.get(link.objectId);
    const label = release?.fixLabel ?? source?.label;
    const title = `${label ?? "Fix"} shipped${release ? ` in ${release.version}` : ""}`;
    rows.set(link.objectId, {
      ref: withHref(
        { stage: "ship", kind: "shipment", id: link.objectId, label: title },
        projectId,
      ),
      title,
      shippedAt: link.createdAt.toISOString(),
      source,
    });
  }
  return [...rows.values()].sort((a, b) => b.shippedAt.localeCompare(a.shippedAt));
}
