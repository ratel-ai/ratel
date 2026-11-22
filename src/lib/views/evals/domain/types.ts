import type {
  ReplayTranscriptStep,
  ToolAnswerReason,
  ToolAnswerSource,
} from "@/lib/views/eval-gate/types";
import type { ScorerKind } from "@/lib/views/task-scorers/types";
import type { RunSettings, RunSettingsUsed } from "./run-settings";

/**
 * The agent-wide eval set (RC-287). An eval is one recorded ask the agent must
 * keep handling well. It links to zero or more tasks (workflow ids, there is
 * no task table) and is scored by the scorers of those tasks, which `checks`
 * can switch off or override per eval.
 */
export const EVAL_STATUSES = ["suggested", "approved", "archived"] as const;
export type EvalStatus = (typeof EVAL_STATUSES)[number];
/** RC-315: the eval set. A suggestion is in it and runs with it; only an archived (removed) eval is out. */
export const IN_SET_STATUSES = ["approved", "suggested"] as const satisfies readonly EvalStatus[];

/** Where an eval came from: a task eval case of that origin, or a session page. */
export const EVAL_ORIGINS = ["auto", "issue", "user", "fix", "session"] as const;
export type EvalOrigin = (typeof EVAL_ORIGINS)[number];

export const EVAL_RUN_KINDS = ["manual", "nightly", "simulation"] as const;
export type EvalRunKind = (typeof EVAL_RUN_KINDS)[number];

export const EVAL_RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/** `before` replays the agent as recorded, `after` replays it with the fix of a simulation. */
export type EvalSide = "before" | "after";

/** The change of one eval from the previous completed run. */
export type EvalChange = "now_fails" | "fixed" | "same" | "new";

/** Transcripts are kept this long, then only the numbers remain. */
export const EVAL_TRANSCRIPT_TTL_DAYS = 30;

/**
 * RC-641 (decision eval-text-kept): an eval run keeps its replay text whatever
 * the project's content opt-in is, so a person can step through it. Eval runs
 * run only with `cloud-eval-gate` on. The text expires after
 * {@link EVAL_TRANSCRIPT_TTL_DAYS}.
 */
export const EVAL_RUNS_KEEP_TEXT = true;

/**
 * An earlier message, given to the agent as history and not tested: the
 * person, the agent, or (RC-295) a tool call the agent made, with `text` as
 * the tool's answer.
 */
export interface EvalMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** `tool` only: the tool called and its arguments. */
  tool?: string;
  args?: Record<string, unknown>;
}

/** Per scorer: off, or on with an optional limit that wins over the task's limit. */
export interface EvalCheck {
  on: boolean;
  max?: number;
}
export type EvalChecks = Partial<Record<ScorerKind, EvalCheck>>;

/**
 * RC-296: a turn after the eval's message: a fixed message, or one a
 * simulated person writes from its description. Rows from before RC-296 hold
 * plain strings: fixed messages.
 */
export type EvalTurn = { kind: "message"; text: string } | { kind: "person"; description: string };

/** Q4: an eval with a simulated person runs this many times and reports a pass rate. */
export const SIMULATED_PERSON_ATTEMPTS = 3;

/** RC-295: answers every call of `tool` that passes the `when` arguments (all calls without them), before the recording. */
export interface EvalFixedAnswer {
  tool: string;
  result: unknown;
  when?: Record<string, unknown>;
  /** Why the answer is fixed, shown with the answer. */
  why?: string;
}

/** RC-608: a tool the eval offers the model, as the recording or the filler gives it. */
export interface EvalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** RC-608: the parts of an eval's spec a model may write when the recording lacks them. */
export const EVAL_SPEC_FIELDS = ["systemPrompt", "message", "tools", "context"] as const;
export type EvalSpecField = (typeof EVAL_SPEC_FIELDS)[number];

/** RC-616: the low reading that made a score-based suggestion: which scorer, its value, and its good threshold. */
export interface SuggestionReason {
  scorerId: string;
  scorerName: string;
  value: number;
  threshold: number;
}

export interface Eval {
  id: string;
  projectId: string;
  name: string;
  sourceTurnId: string | null;
  sourceCaseId: string | null;
  message: string;
  earlierMessages: EvalMessage[];
  turns: EvalTurn[];
  checks: EvalChecks;
  expectedTool: string | null;
  criteria: string;
  fixedAnswers: EvalFixedAnswer[];
  /** RC-608: the system prompt the model is given; null when the eval has none. */
  systemPrompt?: string | null;
  /** RC-608: the tools the model is offered; null when the eval has none. */
  tools?: EvalTool[] | null;
  /** RC-608: named values that ground the IDs the agent passes (a booking reference); null when the eval has none. */
  context?: Record<string, string> | null;
  /** RC-608: the spec fields a model wrote at creation (empty when it wrote none). */
  generated?: EvalSpecField[];
  /** RC-642: the spec fields a person edited. They win over the recording when the eval replays it. */
  edited?: EvalSpecField[];
  /** RC-616: set only on a score-based suggestion. */
  suggestionReason?: SuggestionReason;
  /** RC-653: the eval's own run settings. Absent: the suite default, then today's. */
  runSettings?: RunSettings;
  /** RC-654: the steps a run starts with after the ask (an edited agent reply and the steps before it). Absent: none. */
  opening?: ReplayTranscriptStep[];
  status: EvalStatus;
  origin: EvalOrigin;
  /** Workflow ids, sorted. */
  tasks: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvalSpend {
  usd: number;
  reservedUsd: number;
  reserved: boolean;
}

export interface EvalRun {
  id: string;
  projectId: string;
  kind: EvalRunKind;
  fixId: string | null;
  suite: string;
  status: EvalRunStatus;
  spend: EvalSpend;
  evalCount: number;
  error: string | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One scorer's verdict. `skip` is a scorer that does not apply (a dot in the table). */
export interface EvalVerdict {
  kind: ScorerKind;
  status: "pass" | "fail" | "skip";
  measured: number | string | null;
  limit: number | string | null;
  detail: string;
}

/** Per call, as the replay engine decided it (lib/eval-gate/replay.ts). No args or results: those are text and live in the transcript. */
export interface EvalToolAnswer {
  tool: string;
  source: ToolAnswerSource;
  reason: ToolAnswerReason;
  ms: number | null;
  /** RC-295: a fixed answer's reason, as its author wrote it. */
  why?: string;
}

/**
 * RC-296: one turn of a multi-turn eval, scored on its own. `message` is the
 * person's words (text: only with the content opt-in); `answers` is how many
 * of the result's tool answers this turn made, in order.
 */
export interface EvalTurnResult {
  simulated: boolean;
  message: string | null;
  passed: boolean | null;
  verdicts: EvalVerdict[];
  answers: number;
}

/** RC-296: how many of an eval's runs passed (Q4: a simulated person runs it several times). */
export interface EvalAttempts {
  passed: number;
  total: number;
}

/** The replay's text: assistant turns with their calls, and each tool answer. */
export interface EvalTranscript {
  toolsOffered: string[];
  steps: ReplayTranscriptStep[];
}

export interface EvalResult {
  id: string;
  projectId: string;
  runId: string;
  evalId: string;
  side: EvalSide;
  passed: boolean | null;
  verdicts: EvalVerdict[];
  change: EvalChange | null;
  durationMs: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  toolAnswers: EvalToolAnswer[];
  /** Null after the TTL (RC-641: kept until then, whatever the content opt-in). */
  transcript: EvalTranscript | null;
  /** RC-296: per turn, for an eval with turns; null otherwise. */
  turns?: EvalTurnResult[] | null;
  /** RC-296: null for an eval that runs once. */
  attempts?: EvalAttempts | null;
  /** RC-609: the spec inputs a model wrote (RC-608) that this run used. Absent when it used none. */
  generated?: EvalSpecField[];
  /** RC-653: the run settings this result ran with. Absent on results before RC-653. */
  runSettings?: RunSettingsUsed;
  error: string | null;
  createdAt: Date;
}
