import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { composition } from "@/lib/composition/ports";

/**
 * The analysis filter shim: the upstream function over the analysis filter port. Every analysis
 * query of spans or events applies it, so no job reads a trace the edition did not analyze.
 */

/** True for a row of `traceId` that analysis may read; undefined when the edition filters nothing. */
export function analyzedTraceCondition(
  projectId: string | SQLWrapper,
  traceId: SQLWrapper,
): Promise<SQL | undefined> {
  return composition.analysisFilter.analyzedTraceCondition(projectId, traceId);
}

/** The condition as the tail of a raw `where`: `and …`, or nothing. */
export async function andAnalyzedTrace(
  projectId: string | SQLWrapper,
  traceId: SQLWrapper,
): Promise<SQL> {
  const condition = await analyzedTraceCondition(projectId, traceId);
  return condition ? sql`and ${condition}` : sql.empty();
}
