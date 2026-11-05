import type { FixExperimentRow, FixShipmentRow } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import {
  fixSourceRef,
  experimentRef as lineageExperimentRef,
  fixRef as lineageFixRef,
  shipmentRef as lineageShipmentRef,
  withHref,
} from "@/lib/views/lineage/refs";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * Lineage refs for the objects the loop tools return, built with RC-45's
 * `lib/lineage/refs` so the MCP, the Ship page and `chainOf` name every object
 * the same way:
 *
 * - fix: its Fix id (`issue:<id>`, `craft:<id>`, `rewrite:<id>`, `intent:<id>`).
 * - experiment: its name (the `ratel.experiment.id` its spans carry).
 * - eval: the eval set id, with an href to the fix's eval page (RC-46).
 * - shipment: the `fix_shipments` row id.
 *
 * Pure, so the shape every tool hands back is tested once.
 */

export function fixRef(projectId: string, fix: Pick<Fix, "id" | "title">): LineageRef {
  return withHref(lineageFixRef(fix.id, fix.title), projectId);
}

/** The insight a fix resolves, when it resolves one. */
export function insightIdOf(fix: Pick<Fix, "issues">): string | null {
  return fix.issues[0]?.id ?? null;
}

/**
 * Where a fix came from, as the console says it (`fixSourceRef`): the insight
 * it resolves, else the intent it was found in, else the task it helps. A fix
 * drafted from measurements alone (search misses, tool co-usage) names that
 * measurement, a Monitor metric.
 */
export function fixSource(
  projectId: string,
  fix: Pick<Fix, "issues" | "source" | "sourceId" | "intent" | "subject">,
): LineageRef {
  const named = fixSourceRef(projectId, fix);
  if (named) return named;
  const label =
    fix.source === "rewrite"
      ? "Search misses"
      : fix.source === "craft"
        ? "Tools used together"
        : "Measured runs";
  return withHref(
    { stage: "monitor", kind: "metric", id: `${fix.source}:${fix.sourceId}`, label },
    projectId,
  );
}

/** The experiment, by its name, opened on its experiment page in the project. */
export function experimentRef(projectId: string, row: Pick<FixExperimentRow, "name">): LineageRef {
  return withHref(lineageExperimentRef(row.name), projectId);
}

/** The shipment, opened on Ship (`?peek=<id>`). */
export function shipmentRef(
  projectId: string,
  row: Pick<FixShipmentRow, "id" | "version">,
): LineageRef {
  return withHref(lineageShipmentRef(row.id, `Shipped in ${row.version}`), projectId);
}
