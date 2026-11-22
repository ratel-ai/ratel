import type { ReactNode } from "react";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  loadShipmentCommits,
  type ShipmentCommitsView,
} from "@/lib/views/code-handoff/deploy/shipment-commits";
import { ShipmentCommits } from "./ShipmentCommits";

/**
 * Ship's opened shipment gets its repo commits here (RC-921), so the Ship page
 * and `ShipmentsTable` take one added line each. Null for a shipment no commit
 * carried, or when the read fails.
 */

export interface ShipmentCommitsForDeps {
  load: (projectId: string, shipmentId: string) => Promise<ShipmentCommitsView | null>;
}

const defaultDeps: ShipmentCommitsForDeps = {
  load: (projectId, shipmentId) => loadShipmentCommits(projectId, shipmentId),
};

export async function shipmentCommitsFor(
  projectId: string,
  shipmentId: string,
  deps: ShipmentCommitsForDeps = defaultDeps,
): Promise<ReactNode> {
  const view = await loadOrFallback<ShipmentCommitsView | null>({
    operation: "ship_shipment_commits",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => deps.load(projectId, shipmentId),
  });
  return view ? <ShipmentCommits view={view} /> : null;
}
