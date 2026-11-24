import type { OrgLimitView } from "@/lib/contracts/entitlements";

/**
 * The ingest decision for a whole trace. `analyzed`: stored and analyzed.
 * `ingested_only`: stored, never analyzed. `dropped`: its spans are not stored.
 */
export type TraceOutcome = "analyzed" | "ingested_only" | "dropped";

/** Whose traces are metered. The Cloud side reads its plan columns from the organization row. */
export type TraceMeteringScope = { organization: OrgLimitView; projectId: string };

/**
 * What the edition does with each trace that live ingest receives. The open-source edition meters
 * nothing: every trace is analyzed.
 */
export interface TraceMeteringPort {
  /**
   * Whether this organization's traces are metered. While true, the monthly event cap does not
   * reject an export: the per-trace outcome decides instead.
   */
  isMetered(scope: TraceMeteringScope): Promise<boolean>;
  /**
   * Counts a batch's traces and decides each one. A trace arrives in many batches and must keep
   * the outcome of its first. `traceIds` holds each id once, never an empty one; an id missing
   * from the answer is analyzed. Called only while `isMetered`, before anything is stored. The
   * caller treats a failure as "all analyzed".
   */
  meterTraceBatch(
    scope: TraceMeteringScope,
    traceIds: readonly string[],
  ): Promise<ReadonlyMap<string, TraceOutcome>>;
}
