import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import type { FixExperimentRow, FixShipmentRow } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import { experimentRef, fixRef, insightIdOf, shipmentRef } from "@/lib/views/lineage/loop-refs";
import { fixSourceRef } from "@/lib/views/lineage/refs";
import { type RecordLineageInput, recordLineage } from "@/lib/views/lineage/resolve";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * The one way a fix is recorded as shipped, for `mark_fix_shipped` and the
 * Mark as shipped button on Fixes. It stores the shipment (`createFixShipment`
 * queues the post-ship measures only when `cloud-eval-gate` is on), links the
 * fix to its source and the shipment to the fix or its experiment, and emits
 * `fix_shipped`. The `surface` on the event tells the callers apart.
 */

const logger = getLogger("fixes/record-shipment");

/** The fields a person or an agent gives: the release and an optional note. */
export const shipmentFields = z.object({
  version: z.string().trim().min(1).max(100),
  notes: z.string().max(1_000).optional(),
});

export interface RecordFixShipmentInput {
  projectId: string;
  fix: Fix;
  /** The experiment that tested the fix, when given: it becomes the source of the shipment. */
  experiment: Pick<FixExperimentRow, "id" | "name"> | null;
  version: string;
  notes: string | null;
  /** Who shipped, as the row stores it: a Clerk id, or `project:<id>` for an API key. */
  shippedBy: string;
  actor: RecordLineageInput["actor"];
  surface: "mcp" | "fixes";
}

export interface RecordFixShipmentDeps {
  createFixShipment: typeof createFixShipment;
  recordLineage: typeof recordLineage;
  trackServerEvent: typeof trackServerEvent;
}

export interface RecordedFixShipment {
  row: FixShipmentRow;
  /** What the shipment came from: the experiment, else the fix. */
  source: LineageRef;
  /** The fix, as a lineage ref. */
  self: LineageRef;
}

export const defaultRecordFixShipmentDeps: RecordFixShipmentDeps = {
  createFixShipment,
  recordLineage,
  trackServerEvent,
};

export async function recordFixShipment(
  input: RecordFixShipmentInput,
  deps: RecordFixShipmentDeps = defaultRecordFixShipmentDeps,
): Promise<RecordedFixShipment> {
  const { projectId, fix, experiment } = input;
  const insightId = insightIdOf(fix);
  const row = await deps.createFixShipment({
    projectId,
    fixId: fix.id,
    insightId,
    experimentId: experiment?.id ?? null,
    version: input.version,
    notes: input.notes,
    shippedBy: input.shippedBy,
  });

  const self = fixRef(projectId, fix);
  const source = experiment ? experimentRef(projectId, experiment) : self;
  const fixSource = fixSourceRef(projectId, fix);
  // The row is the shipment: once it is stored, a failed link must not read as
  // a failed save, or a retry stores the shipment twice. Ship still lists it;
  // only its trail back to the run is missing.
  try {
    if (fixSource)
      await deps.recordLineage({ projectId, object: self, source: fixSource, actor: input.actor });
    await deps.recordLineage({
      projectId,
      object: shipmentRef(projectId, row),
      source,
      actor: input.actor,
    });
  } catch (err) {
    logger.error(
      { err, project_id: projectId, fix_id: fix.id, shipment_id: row.id },
      "shipment lineage failed",
    );
    reportServerException(err, input.shippedBy, {
      project_id: projectId,
      shipment_id: row.id,
      operation: "fix_shipment_lineage",
    });
  }
  await deps.trackServerEvent("fix_shipped", input.actor, {
    object_action: "fix_shipped",
    fix_id: fix.id,
    shipment_id: row.id,
    has_insight: insightId !== null,
    has_experiment: experiment !== null,
    surface: input.surface,
  });
  return { row, source, self };
}
