import type { TurnContent } from "../domain/from-turn";

/** The table of one RQL query, or why it did not run. */
export type RqlTable =
  | { ok: true; columns: ReadonlyArray<{ name: string }>; rows: ReadonlyArray<readonly unknown[]> }
  | { ok: false; message: string };

/**
 * The traces, the tasks and RQL, as a query dataset reads them when a run starts. The adapter calls
 * the public functions of those modules. Each list is of closed turns, the newest first.
 */
export interface TraceSource {
  /** Whether the project lets Ratel read captured text. Without it no row is built from a trace. */
  readContent(projectId: string): Promise<boolean>;
  lastTurns(projectId: string, limit: number): Promise<string[]>;
  taskTurns(projectId: string, taskId: string, limit: number): Promise<string[]>;
  runRql(projectId: string, text: string): Promise<RqlTable>;
  /** The turn of each trace that has one, by the trace id. */
  turnsOfTraces(projectId: string, traceIds: readonly string[]): Promise<Map<string, string>>;
  /** "Let Ratel choose": the chosen turns, in order. */
  chooseTurns(projectId: string, taskId: string | null, limit: number): Promise<string[]>;
  loadTurn(projectId: string, turnId: string): Promise<TurnContent | null>;
  /** The tools that run for real in a sandbox, so a row needs no fixture of them. */
  readOnlyTools(projectId: string): Promise<ReadonlySet<string>>;
}
