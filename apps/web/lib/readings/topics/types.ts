import { envNumber } from "@/lib/platform/env-number";

/**
 * Topics (Intents): what people ask the agent about, named in plain words, and
 * how it goes. The `assign_topics` job reads the last 30 days of closed turns,
 * groups their asks into topics, places every turn in one, and stores the
 * numbers and the Flows (topics across a conversation's turns) as one row per
 * project (`trace_topic_insights`). Everything stored here is ids and counts:
 * example asks are read from the turn's own captured events when a panel opens.
 */

export const TOPIC_INSIGHTS_VERSION = 1;

/** Days a reading covers. */
export const TOPIC_WINDOW_DAYS = 30;

/** Closed turns one reading reads at most, newest first. Env `TOPICS_MAX_TURNS`. */
export const TOPICS_MAX_TURNS = Math.floor(envNumber("TOPICS_MAX_TURNS", 20_000));

/** Topics kept at once; a new one waits for a retirement past this. */
export const MAX_ACTIVE_TOPICS = 20;

/** Topics one model call names at most. */
export const MAX_NAMED_PER_RUN = 12;

/**
 * A new topic needs this many turns and this share of the turns with an ask;
 * the asks that fit none must add up to as much before any is looked for.
 */
export const NEW_TOPIC_MIN_TURNS = Math.floor(envNumber("TOPICS_NEW_MIN_TURNS", 5));
export const NEW_TOPIC_MIN_SHARE = 0.01;

/** Distinct asks put to the decision engine per job, busiest first; the rest are placed by wording. Env `TOPICS_MAX_JUDGED_ASKS`. */
export const MAX_JUDGED_ASKS = Math.floor(envNumber("TOPICS_MAX_JUDGED_ASKS", 300));

/** Distinct asks in the users' own words read for sentiment by the decision engine per job. Env `TOPICS_MAX_SENTIMENT_ASKS`. */
export const MAX_SENTIMENT_ASKS = Math.floor(envNumber("TOPICS_MAX_SENTIMENT_ASKS", 300));

/** The decision engine's input-token cap for one job (both questions share it). Env `TOPICS_MAX_JUDGE_TOKENS`. */
export const TOPICS_MAX_JUDGE_TOKENS = Math.floor(envNumber("TOPICS_MAX_JUDGE_TOKENS", 2_000_000));

/** Steps a flow draws: the 1st to the 4th turn of a conversation, then Ended. */
export const FLOW_STEPS = 4;
/** Intents (or tasks, or tools) named at each step; the rest fold into Other, so a step reads at a glance. */
export const FLOW_TOPICS_PER_STEP = 5;
/** Starting keys the flows are precomputed for, besides everyone: every first ask a step names, so each can be followed. */
export const FLOW_STARTS = FLOW_TOPICS_PER_STEP;

export const TOOLS_PER_TOPIC = 8;
export const TASKS_PER_TOPIC = 3;
export const EXAMPLES_PER_TOPIC = 5;
export const NEXT_PER_TOPIC = 5;
export const TOOLS_PER_STEP = 6;
export const EXAMPLES_PER_STEP = 3;

/** A topic or a flow step whose turns went unanswered more often than this is marked. */
export const UNANSWERED_MARK_SHARE = 0.5;
/** Fewest turns before a topic can be marked as mostly unanswered. */
export const UNANSWERED_MARK_MIN_TURNS = 5;
/** Fewest turns read for sentiment before a topic can be the "most negative". */
export const MOST_NEGATIVE_MIN_TURNS = 5;

/**
 * A turn read from a trace of model calls alone (no search, no tool call, so
 * no ledger turn) has this id: `trace:<trace id>`. It counts in its topic and
 * in the Flows, as unanswered, but has no `trace_turn_topics` row.
 */
export const MODEL_ONLY_PREFIX = "trace:";

export function isModelOnlyTurn(id: string): boolean {
  return id.startsWith(MODEL_ONLY_PREFIX);
}

/** Where a turn's ask was read from: the SDK turn scope's user message, an OTel prompt, or the agent's first search. */
export type AskSourceKind = "user" | "prompt" | "search";

/**
 * A turn's place: in a topic, asking the previous turn's question again, in
 * no topic, or with no ask to read. `no_ask` covers runs whose only text was a
 * search once the users' own words are captured (`preferUserAsks`).
 */
export type TopicVerdict = "topic" | "retry" | "none" | "no_ask";

export type Sentiment = "positive" | "neutral" | "negative";

export interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
}

/** A tool (a catalog id, a skill as `skill:<id>`) with its calls and failed calls. */
export interface CountedTool {
  id: string;
  calls: number;
  failures: number;
}

/** What followed a topic's turns, or a step's: a topic id, `retry`, `other` or `ended`. */
export interface NextCount {
  key: string;
  sessions: number;
}

export const NEXT_RETRY = "retry";
/**
 * A turn with none of the ask's words steps through Flows as the task the agent
 * ran (`task:<task id>`), so a customer that sends no text still sees what
 * comes next. A turn with neither is Other.
 */
export const FLOW_TASK_PREFIX = "task:";
export const flowTaskKey = (taskId: string): string => `${FLOW_TASK_PREFIX}${taskId}`;
export const flowTaskId = (key: string): string | null =>
  key.startsWith(FLOW_TASK_PREFIX) ? key.slice(FLOW_TASK_PREFIX.length) : null;
/** With no ask text and no task either, the step is the first tool the turn called (`tool:<tool id>`). */
export const FLOW_TOOL_PREFIX = "tool:";
export const flowToolKey = (toolId: string): string => `${FLOW_TOOL_PREFIX}${toolId}`;
export const flowToolId = (key: string): string | null =>
  key.startsWith(FLOW_TOOL_PREFIX) ? key.slice(FLOW_TOOL_PREFIX.length) : null;
export const NEXT_OTHER = "other";
export const NEXT_ENDED = "ended";

export interface TopicStats {
  id: string;
  /** Turns placed in it (retries not included). */
  turns: number;
  /** Distinct asks placed in it. */
  asks: number;
  /** Turns per UTC day over the window, oldest first. */
  daily: number[];
  /** Turns where a tool ran and the turn did not end on a failed call. */
  answered: number;
  /** Null when none of its turns carried the user's own words. */
  sentiment: SentimentCounts | null;
  /** Tasks serving it, busiest first, with their turns. */
  tasks: { id: string; turns: number }[];
  /** Turns no task holds. */
  untasked: number;
  /** Tools its turns called, busiest first. */
  tools: CountedTool[];
  /** Self-corrections in its turns; null before any were recorded for the window. */
  selfCorrections: { events: number; turns: number; byKind: Record<string, number> } | null;
  /** Turn ids to read example asks from, newest first, one per distinct ask. */
  examples: string[];
  /** Turns that asked this topic's question again straight after it. */
  askedAgain: number;
  /** What people asked next in the same conversation; empty without trusted sessions. */
  next: NextCount[];
  /** Conversations holding at least one of its turns. Absent without trusted sessions, and on readings before it. */
  conversations?: number;
  /**
   * How the intent gets done, read from its turns' calls (`patterns.ts`).
   * Absent on intents with fewer than `PATTERN_MIN_TURNS` turns, and on
   * readings before it.
   */
  pattern?: StoredTopicPattern;
}

/** A tool (a catalog id, a skill as `skill:<id>`) and how many of an intent's turns called it. */
export interface PatternTool {
  id: string;
  turns: number;
}

/**
 * One "What comes before" step inside an intent: of the intent's turns that
 * ran `tool`, `together` had `first` run before it (anywhere earlier in the
 * turn). Kept only when it clears Agent health's bars (`patterns.ts`).
 */
export interface ComesBeforeStep {
  first: string;
  tool: string;
  turns: number;
  together: number;
}

/**
 * How one intent gets done, with the project's helper tools (Agent health's
 * ubiquitous tools) set aside and named apart. Ids and counts only. Every
 * share is over the intent's turns (`TopicStats.turns`).
 */
export interface StoredTopicPattern {
  /** The intent's turns that called anything; the rest asked and nothing ran. */
  withCalls: number;
  /** The tools in at least half its turns, at most six, in their usual order; empty when none is. */
  tools: PatternTool[];
  /** Turns that ran every one of `tools`... */
  runs: number;
  /** ...and of those, turns that first called them in `tools` order. */
  inOrder: number;
  /** Tools in at least a fifth of its turns (and two of them) under the pattern, busiest first. */
  also: PatternTool[];
  /** The project's helper tools this intent runs in most of its turns, busiest first: named apart, never drawn. */
  helpers: PatternTool[];
  /** What its turns start with, helpers skipped: the pattern's tools, then others seen twice or more, busiest first. */
  firsts: PatternTool[];
  /** "What comes before" steps that hold inside the intent, heaviest first. */
  comesBefore: ComesBeforeStep[];
  /** Turns that invoked a skill, and turns where a skill search offered one. */
  skills: { invoked: number; offered: number };
}

export interface FlowNode {
  /** A topic id, `retry` (Asked again) or `other`. */
  key: string;
  /** Conversations at this node: each holds one turn at this step. */
  sessions: number;
  unanswered: number;
  /** Of those, conversations that ended here. */
  ended: number;
  /** Where the rest went at the next step, busiest first. */
  next: NextCount[];
  tools: CountedTool[];
  examples: string[];
}

export interface FlowColumn {
  /** 1-based step. */
  position: number;
  sessions: number;
  ended: number;
  nodes: FlowNode[];
}

export interface FlowStats {
  /** Conversations in this view. */
  sessions: number;
  /** Of those, conversations with two turns or more. */
  multiTurn: number;
  /** Conversations that went on past the last step drawn. */
  wentOn: number;
  columns: FlowColumn[];
}

export interface TopicFlows {
  all: FlowStats;
  /** The busiest starting topics, busiest first; each has a view in `byStart`. */
  starts: string[];
  byStart: Record<string, FlowStats>;
}

export interface TopicInsights {
  version: typeof TOPIC_INSIGHTS_VERSION;
  windowDays: number;
  /** ISO times: the window read. `readFrom` is later than `windowStart` when the reading was capped. */
  windowStart: string;
  windowEnd: string;
  readFrom: string;
  capped: boolean;
  /** Closed turns read, model-only traces included. */
  turns: number;
  /** Of those, traces of model calls alone: no tool ran, so none was answered. Absent on readings before it. */
  modelOnlyTurns?: number;
  /** Of those, turns that ran a tool but whose captured reply says the agent could not do it. */
  refusedTurns?: number;
  /** Turns by where their ask came from; `none` had nothing to read. */
  sources: { user: number; prompt: number; search: number; none: number };
  verdicts: Record<TopicVerdict, number>;
  /** Turns whose sentiment was read (the users' own words only). */
  sentimentMeasured: number;
  /**
   * How those turns were read: by the decision engine (`model`) or by the
   * keyword list (`words`, `sentiment.ts`). Absent on readings before it.
   */
  sentimentRead?: { model: number; words: number };
  /**
   * Turns by lane: OpenTelemetry (`telemetry`) or the Ratel SDK (`sdk`), and
   * the telemetry turns that carried no conversation id, so each one is a
   * conversation of its own. What Flows says when it has nothing to follow.
   * Absent on readings before it.
   */
  lanes?: { telemetry: number; sdk: number; telemetryWithoutConversation: number };
  /** How names were written and asks placed this time. */
  naming: "model" | "words" | "none";
  placement: "judged" | "words" | "mixed" | "none";
  /** The last naming call's input hash: the same input is never sent twice. */
  namingHash: string | null;
  /** Busiest first. */
  topics: TopicStats[];
  /** Turns whose ask fit no topic, and how many of those were answered. */
  unplaced: { turns: number; answered: number };
  /** Every tool topic turns called, with the task whose runs called it most. */
  tools: (CountedTool & { task: string | null })[];
  /** Null when sessions cannot be trusted to hold one user's turns in order. */
  flows: TopicFlows | null;
  flowsBlocked: "sessions_mixed" | null;
}

/** A topic as stored in `trace_topics`. */
export interface StoredTopic {
  topicId: string;
  name: string;
  description: string;
  labelSource: "llm" | "words" | "user";
  model: string | null;
  inputHash: string;
  retiredAt: Date | null;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

/** The window a reading at `now` covers. */
export function topicWindow(now: Date, days: number = TOPIC_WINDOW_DAYS): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

/** Index of `at`'s UTC day in a window of `days` ending at `end`, oldest first; -1 outside it. */
export function dayIndex(at: Date, end: Date, days: number = TOPIC_WINDOW_DAYS): number {
  const endDay = Math.floor(end.getTime() / DAY_MS);
  const day = Math.floor(at.getTime() / DAY_MS);
  const index = days - 1 - (endDay - day);
  return index >= 0 && index < days ? index : -1;
}
