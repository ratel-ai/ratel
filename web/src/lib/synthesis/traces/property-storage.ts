import type { TracePropertyActionDeps } from "@/lib/ingest/properties/actions";
import { enqueuePropertyFill } from "@/lib/ingest/properties/fill";
import {
  clearIndexedAt,
  countUserIndexed,
  findTraceProperty,
  setTracePropertyState,
} from "@/lib/ingest/properties/store";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { getDb } from "@/lib/platform/db/client";
import { getLimits } from "@/lib/platform/entitlements";
import { erasePropertyValues } from "./property-values";

/**
 * What `changeTraceProperty` stands on besides the access checks: the entitlement, the keys, the
 * erase and the fill. One for the console's server action and the MCP tool, so both do the same.
 */
export function tracePropertyStorage(
  db: ReturnType<typeof getDb> = getDb(),
  drain: (projectId: string) => void = scheduleProjectDrain,
): Pick<
  TracePropertyActionDeps,
  "indexLimit" | "find" | "countUserIndexed" | "setState" | "erase" | "fill"
> {
  return {
    indexLimit: (organization) => getLimits(organization).maxIndexedPropertiesPerProject ?? 0,
    find: (projectId, name) => findTraceProperty(projectId, name, db),
    countUserIndexed: (projectId) => countUserIndexed(projectId, db),
    setState: (projectId, name, state) => setTracePropertyState(projectId, name, state, db),
    erase: async (projectId, name) => {
      const erased = await erasePropertyValues(db, projectId, name);
      await clearIndexedAt(projectId, name, db);
      return erased;
    },
    fill: async (projectId, names) => {
      await enqueuePropertyFill(projectId, names, db);
      drain(projectId);
    },
  };
}
