import { enqueueJob, type JobsDb } from "@/lib/jobs/queries";

/**
 * The fill of stored traces for properties that became indexed: a job of this kind runs the
 * backfill (`synthesis/traces/property-backfill.ts`) over the raw store for its names.
 */

export const FILL_TRACE_PROPERTIES_JOB = "fill_trace_properties";

export interface FillTracePropertiesPayload {
  names: string[];
}

/** Queue the fill; the drain runs it (after the response, or within a minute). */
export async function enqueuePropertyFill(
  projectId: string,
  names: readonly string[],
  db?: JobsDb,
): Promise<void> {
  const payload: FillTracePropertiesPayload = { names: [...names] };
  await enqueueJob({ projectId, kind: FILL_TRACE_PROPERTIES_JOB, payload }, db);
}

/** The names a queued fill names; none for a payload that is not one. */
export function fillPayloadNames(payload: unknown): string[] {
  const names = (payload as Partial<FillTracePropertiesPayload> | null)?.names;
  return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
}
