import type { Tracer } from "@opentelemetry/api";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getRqlPool } from "@/lib/platform/db/rql-pool";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createPgRqlExecutor } from "./adapters/pg-executor";
import type { RqlTableName } from "./domain/catalog";
import { createRqlGate, type RqlGate } from "./domain/gate";
import { RQL_LIMITS } from "./domain/limits";
import {
  executeCompiled,
  type RqlCompiled,
  type RqlRunErrorCode,
  type RqlRunResult,
} from "./domain/run";
import type { RqlExecutor } from "./ports/executor";

/**
 * The entry point that runs RQL: a compiled query (`compileRql`) on the read-only path, for one
 * project. The default executor uses the RQL pool (`platform/db/rql-pool.ts`), never the primary
 * pool. Each run is one `feature.rql.run` span and one `feature.rql.query_run` event, with the
 * table, numbers and the outcome code only: never the query text or a literal.
 */

export type { RqlGate } from "./domain/gate";
export { createRqlGate } from "./domain/gate";
export type { RqlCompiled, RqlRunError, RqlRunErrorCode, RqlRunResult } from "./domain/run";

export interface RqlRunOptions {
  projectId: string;
}

/** What one run reports: no query text and no literal. */
export interface RqlRunObservation {
  projectId: string;
  table: RqlTableName;
  columnCount: number;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  outcome: "ok" | RqlRunErrorCode;
}

export interface RqlRunDeps {
  executor: RqlExecutor;
  gate: RqlGate;
  timeoutMs: number;
  observe: (observation: RqlRunObservation) => Promise<void>;
  tracer?: Tracer;
}

/** One gate per process: the parallel cap holds across every caller of `runRql`. */
const processGate = createRqlGate();

export async function runRql(
  compiled: RqlCompiled,
  options: RqlRunOptions,
  deps: Partial<RqlRunDeps> = {},
): Promise<RqlRunResult> {
  const executor = deps.executor ?? createPgRqlExecutor(getRqlPool());
  const observe = deps.observe ?? trackRun;
  return withFeatureSpan(
    "rql",
    "run",
    async (span) => {
      const started = performance.now();
      const result = await executeCompiled(compiled, {
        projectId: options.projectId,
        executor,
        gate: deps.gate ?? processGate,
        timeoutMs: deps.timeoutMs ?? RQL_LIMITS.timeoutMs,
      });
      const observation: RqlRunObservation = {
        projectId: options.projectId,
        table: compiled.table,
        columnCount: compiled.columns.length,
        rowCount: result.ok ? result.rows.length : 0,
        truncated: result.ok && result.truncated,
        durationMs: Math.round(performance.now() - started),
        outcome: result.ok ? "ok" : result.error.code,
      };
      span.setAttributes({
        "project.id": observation.projectId,
        "rql.table": observation.table,
        "rql.column_count": observation.columnCount,
        "rql.row_count": observation.rowCount,
        "rql.truncated": observation.truncated,
        "rql.duration_ms": observation.durationMs,
        "rql.outcome": observation.outcome,
      });
      await observe(observation);
      return result;
    },
    { tracer: deps.tracer },
  );
}

function trackRun(observation: RqlRunObservation): Promise<void> {
  return trackServerEvent(
    "feature.rql.query_run",
    { projectId: observation.projectId },
    {
      table: observation.table,
      column_count: observation.columnCount,
      row_count: observation.rowCount,
      truncated: observation.truncated,
      duration_ms: observation.durationMs,
      outcome: observation.outcome,
    },
  );
}
