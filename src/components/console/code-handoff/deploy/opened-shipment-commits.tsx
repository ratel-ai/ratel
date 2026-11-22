import type { ReactNode } from "react";
import type { Organization } from "@/lib/platform/organizations";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  loadShipmentCommits,
  type ShipmentCommitsView,
} from "@/lib/views/code-handoff/deploy/shipment-commits";
import { codeHandoffEnabledFor } from "@/lib/views/code-handoff/gate";
import { ShipmentCommits } from "./ShipmentCommits";

/**
 * Ship's opened shipment gets its repo commits here (RC-921), so the Ship page
 * and `ShipmentsTable` take one added line each. Null with `FF_CODE_HANDOFF`
 * off, for a shipment no commit carried, or when the read fails.
 */

export interface ShipmentCommitsForDeps {
  flagEnabled: (organization: Organization) => Promise<boolean>;
  load: (projectId: string, shipmentId: string) => Promise<ShipmentCommitsView | null>;
}

const defaultDeps: ShipmentCommitsForDeps = {
  flagEnabled: (organization) => codeHandoffEnabledFor(organization),
  load: (projectId, shipmentId) => loadShipmentCommits(projectId, shipmentId),
};

export async function shipmentCommitsFor(
  organization: Organization,
  projectId: string,
  shipmentId: string,
  deps: ShipmentCommitsForDeps = defaultDeps,
): Promise<ReactNode> {
  if (!(await deps.flagEnabled(organization).catch(() => false))) return null;
  const view = await loadOrFallback<ShipmentCommitsView | null>({
    operation: "ship_shipment_commits",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => deps.load(projectId, shipmentId),
  });
  return view ? <ShipmentCommits view={view} /> : null;
}
