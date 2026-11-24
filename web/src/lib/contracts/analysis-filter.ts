import type { SQL, SQLWrapper } from "drizzle-orm";

/**
 * What keeps analysis off a trace that was stored but not analyzed (`TraceOutcome`). The
 * open-source edition analyzes every trace and has no condition.
 */
export interface AnalysisFilterPort {
  /**
   * A SQL condition over the core database, true for a row whose trace analysis may read, or
   * undefined for no filter. It must be true for a null trace id and never null: a caller may
   * negate it. `projectId` is a value or a column.
   */
  analyzedTraceCondition(projectId: string | SQLWrapper, traceId: SQLWrapper): SQL | undefined;
}
