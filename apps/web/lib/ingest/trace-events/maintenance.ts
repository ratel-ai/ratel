import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { traceEventRejects, traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

export interface RuntimeEventRetentionOptions {
  now?: Date;
  retentionDays?: number;
}

export type RuntimeEventMaintenanceDb = Pick<ReturnType<typeof getDb>, "select" | "delete">;

const MILLISECONDS_PER_DAY = 86_400_000;
/** Raw runtime-event retention. Also the window the intent-graph fold seeds
 * from on its first run for a project, since older evidence is already gone. */
export const RUNTIME_EVENT_RETENTION_DAYS = 30;
const RUNTIME_EVENT_REJECT_RETENTION_DAYS = 7;
const PRUNE_BATCH_SIZE = 5_000;

/** Delete one bounded batch of expired native runtime facts by receipt time. */
export async function pruneExpiredRuntimeEvents(
  options: RuntimeEventRetentionOptions = {},
  db: RuntimeEventMaintenanceDb = getDb(),
): Promise<number> {
  const cutoff = retentionCutoff(options, RUNTIME_EVENT_RETENTION_DAYS);
  const expiredIds = db
    .select({ id: traceEvents.id })
    .from(traceEvents)
    .where(and(eq(traceEvents.ingestSource, "runtime"), lt(traceEvents.receivedAt, cutoff)))
    .orderBy(asc(traceEvents.receivedAt), asc(traceEvents.id))
    .limit(PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(traceEvents)
    .where(inArray(traceEvents.id, expiredIds))
    .returning({ id: traceEvents.id });
  return deleted.length;
}

/** Delete one bounded batch of expired reject metadata by receipt time. */
export async function pruneExpiredRuntimeEventRejects(
  options: RuntimeEventRetentionOptions = {},
  db: RuntimeEventMaintenanceDb = getDb(),
): Promise<number> {
  const cutoff = retentionCutoff(options, RUNTIME_EVENT_REJECT_RETENTION_DAYS);
  const expiredIds = db
    .select({ id: traceEventRejects.id })
    .from(traceEventRejects)
    .where(lt(traceEventRejects.receivedAt, cutoff))
    .orderBy(asc(traceEventRejects.receivedAt), asc(traceEventRejects.id))
    .limit(PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(traceEventRejects)
    .where(inArray(traceEventRejects.id, expiredIds))
    .returning({ id: traceEventRejects.id });
  return deleted.length;
}

function retentionCutoff(options: RuntimeEventRetentionOptions, defaultDays: number): Date {
  const configuredDays = options.retentionDays;
  const days =
    configuredDays !== undefined && Number.isInteger(configuredDays) && configuredDays > 0
      ? configuredDays
      : defaultDays;
  return new Date((options.now?.getTime() ?? Date.now()) - days * MILLISECONDS_PER_DAY);
}
