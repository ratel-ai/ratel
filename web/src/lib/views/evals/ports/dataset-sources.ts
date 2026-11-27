import type { ChooseCandidate } from "../domain/choose";
import type { ResolvedRow } from "../domain/dataset";

export type RqlTraces =
  | { ok: true; traceIds: string[]; truncated: boolean }
  | { ok: false; message: string };

/**
 * What a query dataset reads of the traces, the tasks and RQL, by id only: the evals module does
 * not import the internals of those modules. The composition gives the real reads
 * (`adapters/dataset-sources.ts`). Each read is of one project.
 */
export interface DatasetSources {
  /** Whether the project lets Ratel read the captured text of its traces. */
  readContent(projectId: string): Promise<boolean>;
  /** The turns of the newest closed traces, the newest first, at most `limit`. */
  newestTurns(projectId: string, limit: number): Promise<string[]>;
  /** The newest closed turns of one task, at most `limit`. */
  taskTurns(projectId: string, taskId: string, limit: number): Promise<string[]>;
  /** The trace ids of an RQL query: its `trace_id` column. */
  rqlTraces(
    projectId: string,
    text: string,
    window: { since: Date; until: Date },
  ): Promise<RqlTraces>;
  /** The closed turns of these traces, in their order, each one time. */
  turnsOfTraces(projectId: string, traceIds: readonly string[]): Promise<string[]>;
  /** Recent closed turns with what Ratel knows of their result, for "let Ratel choose". */
  chooseCandidates(projectId: string, limit: number): Promise<ChooseCandidate[]>;
  /** "Let Ratel choose" for one task: the selection of the task evals. */
  chooseForTask(projectId: string, taskId: string, limit: number): Promise<string[]>;
  /** A row made from a turn: its input with the earlier messages, and its tool fixtures. Null: no input. */
  turnRow(projectId: string, turnId: string): Promise<ResolvedRow | null>;
}
