import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import type { ModelCall, TurnWindow } from "@/lib/views/eval-gate/calls";
import type { Scorer, ScorerRun } from "@/lib/views/task-scorers/types";
import type { TrainingConsent } from "../domain/consent";
import type { Dataset, DatasetCounts, DatasetFailure, DatasetSettings } from "../domain/dataset";
import type { OverrideInput, RowPageQuery, UseCaseOverride } from "../domain/overrides";
import type { RedactionCounts } from "../domain/redaction";
import type { DatasetRow, StoredRow } from "../domain/rows";
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

/** The cumulative progress a page of rows stores with them. */
export interface BuildProgress {
  counts: DatasetCounts;
  redaction: RedactionCounts;
}

/**
 * The project's fine-tuning dataset versions (RC-1128). Every read and write
 * is scoped to one project. Immutable by shape: rows are only appended, only
 * while the version is `building`, and no method updates a stored row.
 */
export interface DatasetStore {
  /** A new `building` version of the use case, numbered one past its newest. */
  createBuilding(
    projectId: string,
    input: { useCaseId: string; settings: DatasetSettings; createdBy: string },
  ): Promise<Dataset>;
  getDataset(projectId: string, id: string): Promise<Dataset | null>;
  /** The use case's versions, newest first. */
  listDatasets(projectId: string, useCaseId: string): Promise<Dataset[]>;
  /**
   * Inserts rows and stores the progress, in one statement. Refused (`false`,
   * nothing written) when the version is not `building`.
   */
  appendRows(
    projectId: string,
    id: string,
    rows: readonly DatasetRow[],
    progress: BuildProgress,
  ): Promise<boolean>;
  /** The stored rows, by ordinal: what a resumed build replays. */
  storedRows(projectId: string, id: string): Promise<StoredRow[]>;
  /** One page of rows in ordinal order, after `query.after`, of one side or both (RC-1130). */
  listRows(projectId: string, id: string, query: RowPageQuery): Promise<ListedRow[]>;
  /** `building` → `ready`. False when the version is not `building`. */
  markReady(
    projectId: string,
    id: string,
    result: { contentHash: string } & BuildProgress,
  ): Promise<boolean>;
  /** `building` → `failed`, and its rows are deleted. False when the version is not `building`. */
  markFailed(projectId: string, id: string, reason: DatasetFailure): Promise<boolean>;
  /** Deletes one version, its rows and its lineage link. False when the project has no such version. */
  delete(projectId: string, id: string): Promise<boolean>;
  /** Deletes every version of the project, with their rows and lineage links, and returns how many. A consent withdrawal calls it. */
  deleteDatasets(projectId: string): Promise<number>;
}

/** A stored row as the review step reads it. */
export type ListedRow = Omit<DatasetRow, "rowHash">;

export type OverrideWrite =
  | { ok: true; override: UseCaseOverride }
  | { ok: false; reason: "use_case_not_found" | "turn_not_found" };

/**
 * The runs a use case pins or excludes (RC-1130). Scoped to one project
 * through the use case: an archived use case or one of another project is
 * not found, and a turn of another project is refused.
 */
export interface UseCaseOverrideStore {
  listOverrides(projectId: string, useCaseId: string): Promise<UseCaseOverride[]>;
  /** Upserts one run's override. An exclusion keeps its first time until it is cleared. */
  setOverride(
    projectId: string,
    useCaseId: string,
    input: OverrideInput,
    actor: string,
  ): Promise<OverrideWrite>;
}

/** What a build reads besides the use case's turns and calls (RC-1128). */
export interface BuildFactSource {
  /** Session, end-user key, error count and self-corrections of each turn. */
  turnFacts(projectId: string, turnIds: readonly string[]): Promise<Map<string, TurnFacts>>;
  /** The enabled task scorers of each task. */
  taskScorers(projectId: string, taskIds: readonly string[]): Promise<Map<string, Scorer[]>>;
  /** The measured run of each turn, for the task scorers (`expected_tool` reads `tool`). */
  scorerRuns(
    projectId: string,
    turnIds: readonly string[],
    expectedTool: (turnId: string) => string | null,
  ): Promise<Map<string, ScorerRun>>;
  /** The user scorer results of each turn (`run_scores`). */
  userScores(
    projectId: string,
    turnIds: readonly string[],
  ): Promise<Map<string, { status: "pass" | "fail" | "skip" }[]>>;
  /** Turns in `task_eval_cases` of these tasks, not excluded. */
  evalCaseTurnIds(projectId: string, taskIds: readonly string[]): Promise<Set<string>>;
  /** The calls of the turns, without their content: the build's first pass orders them. */
  modelCalls(projectId: string, turns: readonly TurnWindow[]): Promise<Map<string, ModelCall[]>>;
  /** The stored content of these calls, by `events.id`; null for a call that kept none. */
  callPayloads(
    projectId: string,
    eventIds: readonly string[],
  ): Promise<Map<string, CloudEvent | null>>;
}

export interface TurnFacts {
  sessionId: string | null;
  endUserKey: string | null;
  errorCount: number;
  selfCorrections: number;
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
