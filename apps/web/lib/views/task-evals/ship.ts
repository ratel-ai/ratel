import { getDb } from "@/lib/platform/db/client";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { loadFixContext } from "@/lib/views/eval-gate/service";
import {
  type FixShipmentRow,
  fixShipments,
  type NewFixShipmentRow,
} from "@/lib/views/fixes/schema";
import { fixSeams } from "@/lib/views/fixes/seams";
import { queuePostShipMeasures } from "@/lib/views/task-evals/post-ship";
import type { TaskSimulationDeps } from "@/lib/views/task-evals/simulation";

/**
 * A shipment as the task loop records it: upstream's `createFixShipment` (`lib/fixes/loop-queries.ts`)
 * past its gate check. With the eval gate on, the fix is marked live and its tasks are queued for
 * post-ship measuring in the same transaction; with it off, the shipment is one inserted row.
 * Owned (ADR-0030): the Fixes module stays below the task loop, so the branch arrives through
 * `fixSeams.recordShipment`, filled when this module loads. The task loop's registration, the MCP
 * loop tools and the simulations page load it, so the web process has it as well as the worker.
 */
export async function recordShipment(
  input: NewFixShipmentRow,
  write: (values: NewFixShipmentRow) => Promise<FixShipmentRow>,
  db: unknown,
  deps: TaskSimulationDeps = {},
): Promise<FixShipmentRow> {
  const fullDb = (db ?? getDb()) as ReturnType<typeof getDb>;
  if (!(await evalGateEnabledForActor(input.projectId, input.shippedBy, fullDb, deps.flagDeps))) {
    return write(input);
  }
  const ctx = await (deps.loadFix ?? loadFixContext)(input.projectId, input.fixId);
  if (!ctx || ctx.projectId !== input.projectId)
    throw new Error("This fix does not exist in the project.");
  return fullDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(fixShipments)
      .values({ ...input, liveMarkedBy: input.shippedBy, shippedAt: deps.now?.() ?? new Date() })
      .returning();
    await queuePostShipMeasures(row!, ctx.fix, tx);
    return row!;
  });
}

fixSeams.recordShipment = recordShipment;
