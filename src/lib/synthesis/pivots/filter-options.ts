import { listPivots, type PivotsDb } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import { type PivotsFlagOrganization, pivotsEnabled } from "@/lib/platform/pivots-flag";
import type { PivotFilterOption } from "@/lib/synthesis/traces/v2/filters";

export interface PivotFilterOptionsDeps {
  enabled: (projectId: string, organization: PivotsFlagOrganization) => Promise<boolean>;
  list: (projectId: string) => Promise<readonly PivotFilterOption[]>;
}

const defaultDeps: PivotFilterOptionsDeps = {
  enabled: (projectId, organization) => pivotsEnabled(projectId, organization),
  list: (projectId) => listPivots(projectId, getDb() as PivotsDb),
};

/**
 * The pivots the Sessions and Turns bars filter by (RC-885): the project's
 * configured pivots in display order with `FF_PIVOTS` on, else none. The
 * switch is checked first, so with it off no pivot is read and the pages are as
 * before. Owned (ADR-0030): the switch takes the project and the organization
 * the page holds, not an ingest flag organization.
 */
export async function loadPivotFilterOptions(
  projectId: string,
  organization: PivotsFlagOrganization,
  deps: PivotFilterOptionsDeps = defaultDeps,
): Promise<readonly PivotFilterOption[]> {
  if (!(await deps.enabled(projectId, organization))) return [];
  const pivots = await deps.list(projectId);
  return pivots.map(({ key, label }) => ({ key, label }));
}
