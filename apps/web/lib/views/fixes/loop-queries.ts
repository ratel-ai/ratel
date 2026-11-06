import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import {
  type FixExperimentRow,
  type FixShipmentRow,
  fixExperiments,
  fixShipments,
  type NewFixShipmentRow,
} from "@/lib/views/fixes/schema";
import { fixSeams } from "./seams";

/**
 * Reads and writes for the Improve → Ship half of the loop (RC-43): the
 * experiments declared for a fix and the record that a fix shipped. Every read
 * and write is scoped by project id, so an id from another project matches
 * nothing.
 *
 * Owned (ADR-0030): a shipment is one inserted row. Upstream's second path (the
 * shipment marked live and its tasks queued for measuring, in one transaction)
 * is the `fixSeams.recordShipment` seam the task loop fills.
 */

export type LoopDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export interface CreateFixExperimentInput {
  projectId: string;
  fixId: string;
  insightId: string | null;
  name: string;
  baselineArm: string;
  candidateArm: string;
  trafficPercent: number;
  createdBy: string;
}

/** The new row, or `{ duplicate: true }` when the project already has an experiment by that name. */
export async function createFixExperiment(
  input: CreateFixExperimentInput,
): Promise<{ row: FixExperimentRow } | { duplicate: true }> {
  try {
    const [row] = await getDb().insert(fixExperiments).values(input).returning();
    return { row };
  } catch (error) {
    if (isUniqueViolation(error)) return { duplicate: true };
    throw error;
  }
}

export async function getFixExperiment(
  projectId: string,
  experimentId: string,
): Promise<FixExperimentRow | null> {
  const [row] = await getDb()
    .select()
    .from(fixExperiments)
    .where(and(eq(fixExperiments.projectId, projectId), eq(fixExperiments.id, experimentId)))
    .limit(1);
  return row ?? null;
}

export async function listFixExperiments(
  projectId: string,
  fixId: string,
): Promise<FixExperimentRow[]> {
  return getDb()
    .select()
    .from(fixExperiments)
    .where(and(eq(fixExperiments.projectId, projectId), eq(fixExperiments.fixId, fixId)))
    .orderBy(desc(fixExperiments.createdAt))
    .limit(20);
}

export interface CreateFixShipmentInput {
  projectId: string;
  fixId: string;
  insightId: string | null;
  experimentId: string | null;
  version: string;
  notes: string | null;
  shippedBy: string;
}

export async function createFixShipment(
  input: CreateFixShipmentInput,
  db: LoopDb = getDb(),
): Promise<FixShipmentRow> {
  const write = async (values: NewFixShipmentRow): Promise<FixShipmentRow> => {
    const [row] = await db.insert(fixShipments).values(values).returning();
    if (!row) throw new Error("the shipment was not recorded");
    return row;
  };
  return fixSeams.recordShipment ? fixSeams.recordShipment(input, write, db) : write(input);
}

export async function listFixShipments(
  projectId: string,
  fixId: string,
): Promise<FixShipmentRow[]> {
  return getDb()
    .select()
    .from(fixShipments)
    .where(and(eq(fixShipments.projectId, projectId), eq(fixShipments.fixId, fixId)))
    .orderBy(desc(fixShipments.shippedAt))
    .limit(20);
}

/** The project's shipments, newest first, at most this many: what Fixes and list_fixes mark as shipped. */
const SHIPPED_LIMIT = 500;

export type ShippedFixRow = Pick<FixShipmentRow, "id" | "fixId" | "version" | "shippedAt">;

/** Every fix's shipments in the project, newest first (`shippedByFix` keeps each fix's newest). */
export async function listProjectShipments(
  projectId: string,
  db: LoopDb = getDb(),
): Promise<ShippedFixRow[]> {
  return db
    .select({
      id: fixShipments.id,
      fixId: fixShipments.fixId,
      version: fixShipments.version,
      shippedAt: fixShipments.shippedAt,
    })
    .from(fixShipments)
    .where(eq(fixShipments.projectId, projectId))
    .orderBy(desc(fixShipments.shippedAt))
    .limit(SHIPPED_LIMIT);
}
