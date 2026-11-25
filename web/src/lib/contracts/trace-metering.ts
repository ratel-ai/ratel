import type { OrgLimitView } from "@/lib/contracts/entitlements";

/**
 * The ingest decision for a whole trace. `analyzed`: stored and analyzed.
 * `ingested_only`: stored, never analyzed. `dropped`: its spans are not stored.
 */
export type TraceOutcome = "analyzed" | "ingested_only" | "dropped";

/** `refused`: over a span bound of the edition. Nothing of the batch's part of the trace is stored. */
export type IngestOutcome = TraceOutcome | "refused";

/** Whose traces are metered. The Cloud side reads its plan columns from the organization row. */
export type TraceMeteringScope = { organization: OrgLimitView; projectId: string };

/**
 * What the edition does with each trace that live ingest receives. The open-source edition meters
 * nothing: every trace is analyzed.
 */
export interface TraceMeteringPort {
  /**
   * Whether this organization's traces are metered. While true, the monthly event cap does not
   * reject an export: the per-trace outcome and the edition's span bounds decide instead.
   */
  isMetered(scope: TraceMeteringScope): Promise<boolean>;
  /**
   * Counts a batch's traces and decides each one. A trace arrives in many batches and must keep
   * the outcome of its first, but a later batch can be `refused`. `spansByTrace` holds how many
   * spans the batch brings for each id, never an empty id; an id missing from the answer is
   * analyzed. Called only while `isMetered`, before anything is stored. The caller treats a failure
   * as "all analyzed", and answers 429 when the whole export is refused.
   */
  meterTraceBatch(
    scope: TraceMeteringScope,
    spansByTrace: ReadonlyMap<string, number>,
  ): Promise<ReadonlyMap<string, IngestOutcome>>;
  /**
   * Gives back spans that `meterTraceBatch` admitted and the batch could not store, so that the
   * retry does not count two times. Absent, the edition bounds no span.
   */
  releaseSpans?(
    scope: TraceMeteringScope,
    spansByTrace: ReadonlyMap<string, number>,
  ): Promise<void>;
}
