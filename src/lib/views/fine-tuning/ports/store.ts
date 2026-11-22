import type { ModelCall, TurnWindow } from "@/lib/views/eval-gate/calls";
import type { TrainingConsent } from "../domain/consent";
import type { TurnTotals } from "../domain/stats";
import type { UseCase, UseCaseSelector } from "../domain/use-case";

/**
 * The training opt-in store (RC-1123). Every read and write is scoped to one
 * project.
 */
export interface ConsentStore {
  /** The project's active grant, or null. */
  getActiveConsent(projectId: string): Promise<TrainingConsent | null>;
  /** Records a grant. With one active already, returns that grant unchanged and `created: false`. */
  giveConsent(
    projectId: string,
    actor: string,
    textVersion: string,
  ): Promise<{ consent: TrainingConsent; created: boolean }>;
  /** Stamps the active grant as withdrawn. Null when the project has none. */
  withdrawConsent(projectId: string, actor: string): Promise<TrainingConsent | null>;
}

/** The project's fine-tuning datasets. */
export interface DatasetStore {
  /**
   * Deletes every dataset of the project and returns how many. A withdrawal
   * calls it. No datasets exist before the dataset task, so it returns 0.
   */
  deleteDatasets(projectId: string): Promise<number>;
}

/** Why a use case write was refused. */
export type UseCaseRejection = "name_taken" | "not_found";

export type UseCaseWrite = { ok: true; useCase: UseCase } | { ok: false; reason: UseCaseRejection };

/** The project's use cases (RC-1124). Every read and write is scoped to one project. */
export interface UseCaseStore {
  /** The project's use cases, newest first; archived ones only with `includeArchived`. */
  listUseCases(projectId: string, options?: { includeArchived?: boolean }): Promise<UseCase[]>;
  getUseCase(projectId: string, id: string): Promise<UseCase | null>;
  /** A name is unique among the project's use cases that are not archived. */
  createUseCase(
    projectId: string,
    input: { name: string; selector: UseCaseSelector },
    actor: string,
  ): Promise<UseCaseWrite>;
  updateUseCase(
    projectId: string,
    id: string,
    patch: { name?: string; selector?: UseCaseSelector },
  ): Promise<UseCaseWrite>;
  /** Stamps `archived_at`. An archived use case is not found. */
  archiveUseCase(projectId: string, id: string): Promise<UseCaseWrite>;
}

/** A closed turn a selector matched. */
export interface MatchedTurn {
  turnId: string;
  taskId: string | null;
  startedAt: Date;
  endedAt: Date;
}

/**
 * What a use case resolves through (RC-1124): the turns, their traces and
 * their model calls. The adapter reuses `loadTurnTraceIds` and
 * `loadModelCalls`; only the turn match and the span names are its own SQL.
 */
export interface ModelCallSource {
  /** Closed turns of the project that ended in `[since, until)`, of a task OR an intent, newest first, at most `limit`. */
  findClosedTurns(
    projectId: string,
    query: {
      taskIds: readonly string[];
      intentIds: readonly string[];
      since: Date;
      until: Date;
      limit: number;
    },
  ): Promise<MatchedTurn[]>;
  /** Every closed turn the same match finds in the window, counted, with the first and last `ended_at`. */
  turnTotals(
    projectId: string,
    query: { taskIds: readonly string[]; intentIds: readonly string[]; since: Date; until: Date },
  ): Promise<TurnTotals>;
  turnTraceIds(projectId: string, turnIds: readonly string[]): Promise<Map<string, string[]>>;
  modelCalls(projectId: string, turns: readonly TurnWindow[]): Promise<Map<string, ModelCall[]>>;
  /** The project's tasks with closed turns since `since`, busiest first: what a use case can pick. */
  recentTasks(projectId: string, since: Date): Promise<{ taskId: string; turns: number }[]>;
  /** The names of these spans, by `traceId:spanId`. */
  spanNames(
    projectId: string,
    spans: readonly { traceId: string; spanId: string }[],
  ): Promise<Map<string, string>>;
}
