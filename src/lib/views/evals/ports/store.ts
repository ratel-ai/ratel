import type { RunSettings, RunSettingsUsed } from "../domain/run-settings";
import type {
  Eval,
  EvalAttempts,
  EvalChange,
  EvalChecks,
  EvalFixedAnswer,
  EvalMessage,
  EvalOrigin,
  EvalResult,
  EvalRun,
  EvalRunKind,
  EvalRunStatus,
  EvalSide,
  EvalSpecField,
  EvalSpend,
  EvalStatus,
  EvalTool,
  EvalToolAnswer,
  EvalTranscript,
  EvalTurn,
  EvalTurnResult,
  EvalVerdict,
  SuggestionReason,
} from "../domain/types";

/** The persistence port of the Evals feature. Every read and write is scoped to one project. */
export interface EvalStore {
  createEval(input: NewEval): Promise<Eval>;
  /** Inserts each eval whose source case has none yet in the project, with its tasks. Returns how many were added. */
  importEvals(inputs: readonly (NewEval & { sourceCaseId: string })[]): Promise<number>;
  getEval(projectId: string, evalId: string): Promise<Eval | null>;
  listEvals(projectId: string, filter?: EvalFilter): Promise<Eval[]>;
  setEvalStatus(projectId: string, evalId: string, status: EvalStatus): Promise<boolean>;
  /** RC-297: sets the edited fields and replaces the task links. Null when the eval is not in the project. */
  updateEval(projectId: string, evalId: string, patch: EvalPatch): Promise<Eval | null>;
  /** RC-653: replace the eval's run settings (checked by the caller); an empty object clears them. Null when the eval is not in the project. */
  setEvalRunSettings(
    projectId: string,
    evalId: string,
    settings: RunSettings,
  ): Promise<Eval | null>;
  /** RC-654: replace the steps the eval's runs start with; null clears them. Null when the eval is not in the project. */
  setEvalOpening(
    projectId: string,
    evalId: string,
    opening: Eval["opening"] | null,
  ): Promise<Eval | null>;
  /** RC-653: the project's suite default run settings; empty when it has none. */
  getSuiteRunSettings(projectId: string): Promise<RunSettings>;
  /** RC-653: replace the project's suite default run settings (checked by the caller). */
  setSuiteRunSettings(
    projectId: string,
    settings: RunSettings,
    actor: string,
  ): Promise<RunSettings>;
  /** Adds links; existing links stay. False when the eval is not in the project. */
  linkTasks(projectId: string, evalId: string, workflowIds: readonly string[]): Promise<boolean>;
  unlinkTask(projectId: string, evalId: string, workflowId: string): Promise<void>;

  createRun(input: NewEvalRun): Promise<EvalRun>;
  getRun(projectId: string, runId: string): Promise<EvalRun | null>;
  listRuns(
    projectId: string,
    filter?: { kinds?: readonly EvalRunKind[]; fixId?: string; limit?: number },
  ): Promise<EvalRun[]>;
  updateRun(projectId: string, runId: string, patch: EvalRunPatch): Promise<void>;
  /** Upserts by (run, eval, side), so a retried job does not duplicate results. */
  recordResults(projectId: string, runId: string, results: readonly NewEvalResult[]): Promise<void>;
  listResults(projectId: string, runId: string): Promise<EvalResult[]>;
  /** The newest results of each eval over completed manual and nightly runs (the agent today), newest first, at most `perEval` each. */
  recentResults(
    projectId: string,
    evalIds: readonly string[],
    perEval: number,
  ): Promise<Map<string, EvalResult[]>>;

  /** One eval's results with their runs, newest first. */
  resultsForEval(
    projectId: string,
    evalId: string,
    limit: number,
  ): Promise<{ run: EvalRun; result: EvalResult }[]>;
  /** Per run: results that passed, all results, and how many now fail or were fixed. */
  runSummaries(
    projectId: string,
    runIds: readonly string[],
  ): Promise<Map<string, { passed: number; total: number; nowFails: number; fixed: number }>>;

  /** Clears transcripts older than the TTL; verdicts and numbers stay. Returns the count cleared. */
  pruneTranscripts(now?: Date): Promise<number>;
}

export interface EvalFilter {
  workflowId?: string;
  statuses?: readonly EvalStatus[];
}

export interface NewEval {
  projectId: string;
  name: string;
  message: string;
  origin: EvalOrigin;
  createdBy: string;
  status?: EvalStatus;
  sourceTurnId?: string | null;
  sourceCaseId?: string | null;
  earlierMessages?: EvalMessage[];
  turns?: EvalTurn[];
  checks?: EvalChecks;
  expectedTool?: string | null;
  criteria?: string;
  fixedAnswers?: EvalFixedAnswer[];
  tasks?: readonly string[];
  /** RC-608: the spec. Left out (as with the eval gate off), the columns stay null. */
  systemPrompt?: string | null;
  tools?: EvalTool[] | null;
  context?: Record<string, string> | null;
  generated?: EvalSpecField[];
  /** RC-642: the spec fields a person edited (a copy keeps them). */
  edited?: EvalSpecField[];
  /** RC-616: why a score-based suggestion was made. */
  suggestionReason?: SuggestionReason;
  /** RC-653: the eval's own run settings (a copy keeps them). */
  runSettings?: RunSettings;
  /** RC-654: the steps its runs start with after the ask. */
  opening?: Eval["opening"];
}

/** RC-297: what the editor changes. */
export type EvalPatch = Pick<
  Eval,
  | "name"
  | "earlierMessages"
  | "turns"
  | "tasks"
  | "checks"
  | "expectedTool"
  | "criteria"
  | "fixedAnswers"
> &
  /** RC-614, RC-641: spec fields, set only when given. A field set by hand is no longer `generated`, and (RC-642) is `edited`. */
  Partial<Pick<Eval, "message" | "systemPrompt" | "tools" | "context">>;

export interface NewEvalRun {
  projectId: string;
  kind: EvalRunKind;
  createdBy: string;
  fixId?: string | null;
  suite?: string;
  evalCount?: number;
  spend?: EvalSpend;
  /** Defaults to the database's now; the nightly sweep passes its tick time. */
  createdAt?: Date;
}

export interface EvalRunPatch {
  status?: EvalRunStatus;
  spend?: EvalSpend;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface NewEvalResult {
  evalId: string;
  side?: EvalSide;
  passed: boolean | null;
  verdicts: EvalVerdict[];
  change?: EvalChange | null;
  durationMs?: number | null;
  costUsd?: number | null;
  toolCalls?: number | null;
  toolAnswers?: EvalToolAnswer[];
  transcript?: EvalTranscript | null;
  turns?: EvalTurnResult[] | null;
  attempts?: EvalAttempts | null;
  /** RC-609: the generated spec inputs the run used. */
  generated?: EvalSpecField[];
  /** RC-653: the run settings the result ran with. */
  runSettings?: RunSettingsUsed;
  error?: string | null;
  createdAt?: Date;
}
