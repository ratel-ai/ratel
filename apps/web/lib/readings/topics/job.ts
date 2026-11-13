import Anthropic from "@anthropic-ai/sdk";
import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { TURN_IDLE_CLOSE_MS } from "@/lib/ledger/constants";
import { hashEndUser, traceSignalsHashSalt } from "@/lib/ledger/hash";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { configured, resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import type {
  CorpusEntry,
  JudgeEngine,
  JudgeFraming,
  JudgeVerdict,
} from "@/lib/readings/decisions/judge";
import { openaiJudgeEngine } from "@/lib/readings/decisions/openai-judge";
import { DEFAULT_LABEL_MODEL } from "@/lib/readings/model-defaults";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import {
  chooseAsks,
  type DistinctAsk,
  distinctAsks,
  isUserWords,
  retryTurns,
  type TopicTurn,
  type TurnAskText,
} from "@/lib/readings/topics/asks";
import { evolveTopics, type Namer } from "@/lib/readings/topics/evolve";
import { buildNamePrompt, NAME_SCHEMA, parseNamedTopics } from "@/lib/readings/topics/name";
import { topicPatterns, withTopicPatterns } from "@/lib/readings/topics/patterns";
import {
  askCases,
  chosenOption,
  placeAsks,
  SENTIMENT_OPTIONS_PREFIX,
  TOPIC_FRAMING,
  topicOptions,
  topicOptionsHash,
} from "@/lib/readings/topics/place";
import {
  loadHelperTools as loadHelperToolsFn,
  loadModelOnlyTraces as loadModelOnlyTracesFn,
  loadPreviousPlacements as loadPreviousPlacementsFn,
  loadRefusedTraces as loadRefusedTracesFn,
  loadSelfCorrectionKinds as loadSelfCorrectionKindsFn,
  loadStoredTopics as loadStoredTopicsFn,
  loadTopicReading as loadTopicReadingFn,
  loadTurnTasks as loadTurnTasksFn,
  type ModelOnlyTrace,
  readingStart as readingStartFn,
  saveTopicReading as saveTopicReadingFn,
  type TurnTopicRow,
} from "@/lib/readings/topics/queries";
import {
  isSentiment,
  lexiconSentiment,
  SENTIMENT_FRAMING,
  SENTIMENT_OPTIONS,
  SENTIMENT_VERSION,
} from "@/lib/readings/topics/sentiment";
import { buildTopicInsights, type PlacedTurn } from "@/lib/readings/topics/stats";
import {
  isModelOnlyTurn,
  MAX_JUDGED_ASKS,
  MAX_SENTIMENT_ASKS,
  MODEL_ONLY_PREFIX,
  type Sentiment,
  type StoredTopic,
  type StoredTopicPattern,
  TOPICS_MAX_JUDGE_TOKENS,
  TOPICS_MAX_TURNS,
  type TopicInsights,
  topicWindow,
} from "@/lib/readings/topics/types";
import { trustOf } from "@/lib/readings/trace-signals/self-corrections/detect";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import {
  hashText,
  NONE_OPTION_ID,
  normalizeAsk,
} from "@/lib/readings/trace-signals/workflows/decide";
import {
  loadVerdicts as loadVerdictsFn,
  saveVerdicts as saveVerdictsFn,
  type VerdictRow,
} from "@/lib/readings/trace-signals/workflows/decide-queries";
import {
  loadAskSourcesByTurn,
  type TurnAsk,
} from "@/lib/readings/trace-signals/workflows/label-queries";
import {
  chooseRunBasis,
  countRun,
  emptyRunBasisCounts,
} from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * The `assign_topics` job: one reading of a project's topics over the last
 * 30 days of closed turns.
 *
 * 1. Each turn's ask: the user's message, else the OTel prompt, else the
 *    agent's first search; the users' own words win once there are enough.
 *    A turn asking the previous turn's question again is a retry.
 * 2. Distinct asks are placed in the topics there are (the decision engine,
 *    cached per ask and topic set; else where they went before; else by
 *    wording). Groups of asks that fit none become new topics, named by one
 *    model call (at most twelve) or from their own words; a topic with no
 *    asks for a whole window is retired. When the topics changed, asks are
 *    placed again against the new set, within the same cap.
 * 3. Sentiment from the users' own words only: the decision engine, else a
 *    small lexicon.
 * 4. Per-topic numbers and the Flows are written with every turn's place,
 *    with each intent's tool pattern (`patterns.ts`) read from the same
 *    turns, the helper tools of the latest signal run set aside. While that
 *    set is unknown (a run from before it was kept, or a read that failed) no
 *    pattern is read, so a helper is never stored as an intent's own tool;
 *    a failure costs the patterns only, never the reading.
 *
 * Every model call is capped and cached; a failed or missing one falls back
 * to wording, and is logged and reported, never fatal. Logs and events carry
 * counts only: no ask text.
 *
 * Owned (ADR-0030): OpenAI is the one decision engine in this edition, and the
 * default naming model comes from `readings/model-defaults.ts`.
 */

const logger = getLogger("topics/assign");
const SYSTEM_DISTINCT_ID = "system:topics";
/** Turns read per page. */
const PAGE_SIZE = 500;
/** A reading's wall-clock budget for reading turns. */
const TIME_BUDGET_MS = 4 * 60_000;
const ASK_CHUNK = 200;
/** Room for the model's thinking and twelve named topics. */
const NAME_MAX_TOKENS = 16_000;

export interface AssignTopicsDeps {
  now: () => Date;
  maxTurns: number;
  timeBudgetMs: number;
  readingStart: typeof readingStartFn;
  listPage: typeof listClosedTurnsPage;
  loadAsks: (projectId: string, turnIds: readonly string[]) => Promise<Map<string, TurnAsk>>;
  /** Traces of model calls alone in the window: asks with no ledger turn. */
  loadModelOnlyTraces: typeof loadModelOnlyTracesFn;
  /** Traces whose captured final reply says the agent could not do it. */
  loadRefusedTraces: typeof loadRefusedTracesFn;
  /** How long a trace stays quiet before it is read, as a turn closes. */
  idleCloseMs: number;
  /** The end-user hash salt, so a model-only trace joins its user's conversation; null leaves it on its own. */
  hashSalt: string | null;
  loadTurnTasks: typeof loadTurnTasksFn;
  /** The latest signal run's helper tools, set aside from each intent's pattern; null while they are unknown. */
  loadHelperTools: (projectId: string) => Promise<readonly string[] | null>;
  loadSelfCorrections: typeof loadSelfCorrectionKindsFn;
  loadTopics: typeof loadStoredTopicsFn;
  loadPreviousPlacements: typeof loadPreviousPlacementsFn;
  loadReading: typeof loadTopicReadingFn;
  loadVerdicts: typeof loadVerdictsFn;
  saveVerdicts: typeof saveVerdictsFn;
  saveReading: typeof saveTopicReadingFn;
  /** The decision engine with the topic framing; null without a key. */
  judge: JudgeEngine | null;
  /** The decision engine with the sentiment framing; null without a key. */
  sentimentJudge: JudgeEngine | null;
  /** The model that names topics; null without a key. */
  name: Namer | null;
  nameModel: string;
  observability: Pick<BackgroundObservability, "trackSystemEvent">;
}

export interface AssignTopicsResult {
  turns: number;
  /** Of those, traces of model calls alone. */
  modelOnly: number;
  /** Turns that called a tool but whose captured reply says the agent could not do it. */
  refused: number;
  capped: boolean;
  topics: number;
  created: number;
  renamed: number;
  retired: number;
  judged: number;
  sentimentJudged: number;
  /** Intents whose tool pattern was read (enough turns); 0 when the patterns were not read (helpers unknown, or a failure). */
  patterns: number;
  naming: TopicInsights["naming"];
  placement: TopicInsights["placement"];
}

/** Bound on the helper read: one row's JSON path, so a slow one is cut rather than holding the reading. */
const HELPER_READ_TIMEOUT_MS = 5_000;

/** The decision engine (`readings/decisions/engine.ts`, OpenAI here), asking `framing`; null without a usable key. */
export function topicJudgeFromEnv(
  framing: JudgeFraming,
  env: Record<string, string | undefined> = process.env,
): JudgeEngine | null {
  const resolved = resolveDecisionEngine(env);
  if (!resolved) return null;
  return openaiJudgeEngine({
    apiKey: resolved.apiKey,
    baseUrl: configured(env.OPENAI_BASE_URL),
    model: configured(env.OPENAI_DECISIONS_MODEL),
    framing,
    maxInputTokens: TOPICS_MAX_JUDGE_TOKENS,
  });
}

/** One structured-output Anthropic call that names topics; null without an API key. */
export function anthropicTopicNamer(
  model: string,
  env: Record<string, string | undefined> = process.env,
): Namer | null {
  const apiKey = configured(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  return async (groups) => {
    const { system, user } = buildNamePrompt(groups);
    const message = await client.messages.create({
      model,
      max_tokens: NAME_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: NAME_SCHEMA } },
    });
    if (message.stop_reason === "refusal")
      throw new Error("topic names declined by the model's safety filter");
    if (message.stop_reason === "max_tokens")
      throw new Error("topic names cut off at the token limit");
    const raw = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return parseNamedTopics(raw, groups);
  };
}

async function loadAsksInChunks(
  projectId: string,
  turnIds: readonly string[],
): Promise<Map<string, TurnAsk>> {
  const out = new Map<string, TurnAsk>();
  for (let i = 0; i < turnIds.length; i += ASK_CHUNK) {
    const asks = await loadAskSourcesByTurn(projectId, turnIds.slice(i, i + ASK_CHUNK));
    for (const [id, ask] of asks) out.set(id, ask);
  }
  return out;
}

/** The real collaborators; model clients only for what the caller did not supply. */
function defaultDeps(overrides: Partial<AssignTopicsDeps>): AssignTopicsDeps {
  const nameModel =
    process.env.TOPICS_LABEL_MODEL || process.env.TRACE_WORKFLOW_LABEL_MODEL || DEFAULT_LABEL_MODEL;
  return {
    now: () => new Date(),
    maxTurns: TOPICS_MAX_TURNS,
    timeBudgetMs: TIME_BUDGET_MS,
    readingStart: readingStartFn,
    listPage: listClosedTurnsPage,
    loadAsks: loadAsksInChunks,
    loadModelOnlyTraces: loadModelOnlyTracesFn,
    loadRefusedTraces: loadRefusedTracesFn,
    idleCloseMs: TURN_IDLE_CLOSE_MS,
    hashSalt: traceSignalsHashSalt(),
    loadTurnTasks: loadTurnTasksFn,
    loadHelperTools: (projectId) =>
      withStatementTimeout((db) => loadHelperToolsFn(projectId, db), {
        operation: "topics_helper_tools",
        timeoutMs: HELPER_READ_TIMEOUT_MS,
      }),
    loadSelfCorrections: loadSelfCorrectionKindsFn,
    loadTopics: loadStoredTopicsFn,
    loadPreviousPlacements: loadPreviousPlacementsFn,
    loadReading: loadTopicReadingFn,
    loadVerdicts: loadVerdictsFn,
    saveVerdicts: saveVerdictsFn,
    saveReading: saveTopicReadingFn,
    judge: "judge" in overrides ? null : topicJudgeFromEnv(TOPIC_FRAMING),
    sentimentJudge: "sentimentJudge" in overrides ? null : topicJudgeFromEnv(SENTIMENT_FRAMING),
    name: "name" in overrides ? null : anthropicTopicNamer(nameModel),
    nameModel,
    observability: createBackgroundObservability(),
  };
}

/** A closed turn as a reading keeps it: its calls and first search, no text. */
export function toTopicTurn(turn: SignalTurn): TopicTurn {
  const calls = turn.steps.flatMap((step) => {
    const tool = nodeIdOf(step);
    return tool === null ? [] : [{ tool, outcome: step.outcome }];
  });
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    endUserKey: turn.endUserKey ?? null,
    turnSource: turn.turnSource,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    endedBy: turn.endedBy ?? null,
    calls,
    firstSearch: turn.steps.find((step) => step.kind === "search") ?? null,
    workflowId: null,
    traceId: turn.turnKey?.startsWith(OTLP_TURN_PREFIX)
      ? turn.turnKey.slice(OTLP_TURN_PREFIX.length)
      : null,
    ...(offersSkill(turn) ? { skillOffered: true } : {}),
  };
}

const OTLP_TURN_PREFIX = "otlp:";

/** A skill search in the turn returned at least one skill: one was offered, whether or not it ran. */
function offersSkill(turn: Pick<SignalTurn, "steps">): boolean {
  return turn.steps.some(
    (step) =>
      step.kind === "search" &&
      step.searchType === "skill_search" &&
      ((step.hitCount ?? 0) > 0 || (step.hitIds?.length ?? 0) > 0),
  );
}

/** A model-only trace as a turn: no calls (so unanswered), in its user's conversation when it names one. */
export function modelOnlyTurn(trace: ModelOnlyTrace, salt: string | null): TopicTurn {
  return {
    id: `${MODEL_ONLY_PREFIX}${trace.traceId}`,
    sessionId: trace.sessionId ?? `${MODEL_ONLY_PREFIX}${trace.traceId}`,
    endUserKey: salt ? hashEndUser(trace.endUserId, salt) : null,
    turnSource: "otlp",
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    endedBy: null,
    calls: [],
    firstSearch: null,
    workflowId: null,
    traceId: trace.traceId,
  };
}

/** The verdict as the cache keeps it: the chosen option in `workflow_id`. */
function toRow(verdict: JudgeVerdict, known: ReadonlySet<string>): VerdictRow {
  const confidence = verdict.confidence ?? null;
  if (verdict.entryId === NONE_OPTION_ID)
    return { promptHash: verdict.id, verdict: "none", workflowId: null, confidence };
  if (known.has(verdict.entryId))
    return { promptHash: verdict.id, verdict: "workflow", workflowId: verdict.entryId, confidence };
  return { promptHash: verdict.id, verdict: "unclear", workflowId: null, confidence };
}

interface Judged {
  /** Each decided ask: an option id, or null for "none of these". Asks the engine declined are absent. */
  choices: Map<string, string | null>;
  /** Fresh calls made. */
  fresh: number;
}

/**
 * Asks put to the decision engine against `options`, busiest first, at most
 * `budget` fresh ones; cached answers are free. A failed engine is logged and
 * reported, and the asks it did not answer are left to the wording.
 */
async function judgeAsks(
  projectId: string,
  judge: JudgeEngine,
  asks: readonly Pick<DistinctAsk, "hash" | "text">[],
  options: readonly CorpusEntry[],
  optionsHash: string,
  budget: number,
  deps: Pick<AssignTopicsDeps, "loadVerdicts" | "saveVerdicts">,
  operation: string,
): Promise<Judged> {
  const cases = askCases(asks);
  const known = new Set(options.map((option) => option.entryId));
  const choices = new Map<string, string | null>();
  const read = (id: string, entryId: string) => {
    const choice = chosenOption({ entryId }, known);
    if (choice !== null) choices.set(id, choice === NONE_OPTION_ID ? null : choice);
  };
  const cached = await deps.loadVerdicts(
    projectId,
    optionsHash,
    cases.map((c) => c.id),
  );
  for (const [id, verdict] of cached) read(id, verdict.entryId);
  const capacity = judge.capacity ? judge.capacity(options) : budget;
  const missing = cases
    .filter((c) => !cached.has(c.id))
    .slice(0, Math.max(0, Math.min(budget, capacity)));
  if (missing.length === 0) return { choices, fresh: 0 };
  try {
    const fresh = await judge.judge(missing, options);
    await deps.saveVerdicts(
      projectId,
      optionsHash,
      judge.model,
      fresh.map((verdict) => toRow(verdict, known)),
    );
    for (const verdict of fresh) read(verdict.id, verdict.entryId);
    return { choices, fresh: missing.length };
  } catch (err) {
    logger.error(
      { err, project_id: projectId, asks: missing.length, operation },
      "topic decisions failed",
    );
    reportServerException(err, `project:${projectId}`, { operation });
    return { choices, fresh: 0 };
  }
}

/**
 * Sentiment for every distinct ask in the users' own words: the engine where
 * it answers (cached or fresh), else the lexicon. `byModel` holds the asks the
 * engine read, so the page can say how sentiment was read.
 */
async function readSentiment(
  projectId: string,
  asks: readonly DistinctAsk[],
  deps: Pick<AssignTopicsDeps, "sentimentJudge" | "loadVerdicts" | "saveVerdicts">,
): Promise<{ byHash: Map<string, Sentiment>; byModel: Set<string>; judged: number }> {
  const own = asks.filter((ask) => ask.user);
  const byHash = new Map<string, Sentiment>();
  const byModel = new Set<string>();
  let judged = 0;
  if (deps.sentimentJudge && own.length > 0) {
    const hash = topicOptionsHash(SENTIMENT_OPTIONS, SENTIMENT_OPTIONS_PREFIX, SENTIMENT_VERSION);
    const result = await judgeAsks(
      projectId,
      deps.sentimentJudge,
      own,
      SENTIMENT_OPTIONS,
      hash,
      MAX_SENTIMENT_ASKS,
      deps,
      "topic_sentiment",
    );
    judged = result.fresh;
    for (const [id, choice] of result.choices) {
      if (!choice || !isSentiment(choice)) continue;
      byHash.set(id, choice);
      byModel.add(id);
    }
  }
  for (const ask of own)
    if (!byHash.has(ask.hash)) byHash.set(ask.hash, lexiconSentiment(ask.text));
  return { byHash, byModel, judged };
}

/** A new topic's id: short, stable for its seed, unique in the project. */
function idMaker(projectId: string, taken: ReadonlySet<string>): (seed: string) => string {
  const used = new Set(taken);
  return (seed) => {
    const base = `t_${hashText(`${projectId}:${seed}`).slice(0, 10)}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
    used.add(id);
    return id;
  };
}

export async function assignProjectTopics(
  projectId: string,
  overrides: Partial<AssignTopicsDeps> = {},
): Promise<AssignTopicsResult> {
  const deps = { ...defaultDeps(overrides), ...overrides };
  const startedAt = deps.now();
  const window = topicWindow(startedAt);
  try {
    const result = await read(projectId, window, deps);
    const fields = {
      project_id: projectId,
      ...snake(result),
      duration_ms: Math.max(0, deps.now().getTime() - startedAt.getTime()),
    };
    logger.info(fields, "topic reading completed");
    await deps.observability.trackSystemEvent("topic_run_completed", SYSTEM_DISTINCT_ID, {
      object_action: "topic_run_completed",
      ...fields,
    });
    return result;
  } catch (err) {
    const fields = {
      project_id: projectId,
      duration_ms: Math.max(0, deps.now().getTime() - startedAt.getTime()),
    };
    logger.error({ err, ...fields }, "topic reading failed");
    await deps.observability.trackSystemEvent("topic_run_failed", SYSTEM_DISTINCT_ID, {
      object_action: "topic_run_failed",
      ...fields,
    });
    throw err;
  }
}

function snake(result: AssignTopicsResult): Record<string, unknown> {
  return {
    turns: result.turns,
    model_only: result.modelOnly,
    refused: result.refused,
    capped: result.capped,
    topics: result.topics,
    created: result.created,
    renamed: result.renamed,
    retired: result.retired,
    judged: result.judged,
    sentiment_judged: result.sentimentJudged,
    patterns: result.patterns,
    naming: result.naming,
    placement: result.placement,
  };
}

async function read(
  projectId: string,
  window: { from: Date; to: Date },
  deps: AssignTopicsDeps,
): Promise<AssignTopicsResult> {
  const now = window.to;
  const start = await deps.readingStart(projectId, window, deps.maxTurns);
  const turns: TopicTurn[] = [];
  const counts = emptyRunBasisCounts();
  await walkClosedTurnPages(
    deps.listPage,
    projectId,
    { from: start.from, to: window.to },
    {
      pageSize: PAGE_SIZE,
      startedAt: now.getTime(),
      now: deps.now,
      timeBudgetMs: deps.timeBudgetMs,
    },
    (page) => {
      for (const turn of page.turns) {
        const kept = toTopicTurn(turn);
        turns.push(kept);
        countRun(counts, turn, new Set(kept.calls.map((call) => call.tool)).size);
      }
    },
  );
  const turnIds = turns.map((turn) => turn.id);
  const [tasks, rawAsks, stored, previous, reading, corrections, modelOnly] = await Promise.all([
    deps.loadTurnTasks(projectId, turnIds),
    deps.loadAsks(projectId, turnIds),
    deps.loadTopics(projectId),
    deps.loadPreviousPlacements(projectId, turnIds),
    deps.loadReading(projectId),
    deps.loadSelfCorrections(projectId, turnIds),
    deps.loadModelOnlyTraces(
      projectId,
      { from: start.from, to: window.to },
      new Date(now.getTime() - deps.idleCloseMs),
      deps.maxTurns,
    ),
  ]);
  for (const turn of turns) turn.workflowId = tasks.get(turn.id) ?? null;
  // Asks no tool could answer leave no ledger turn: read them from their model calls.
  for (const trace of modelOnly) {
    const turn = modelOnlyTurn(trace, deps.hashSalt);
    turns.push(turn);
    rawAsks.set(turn.id, { text: trace.prompt, source: "prompt" });
  }
  // A lookup is not an answer when the reply says the agent could not do it.
  const refused = await deps.loadRefusedTraces(
    projectId,
    turns.flatMap((turn) => (turn.traceId && turn.calls.length > 0 ? [turn.traceId] : [])),
  );
  for (const turn of turns) if (turn.traceId && refused.has(turn.traceId)) turn.refused = true;

  const asks = chooseAsks(rawAsks);
  const trust = trustOf(chooseRunBasis(counts));
  const retries = retryTurns(turns, asks, trust);
  const distinct = distinctAsks(turns, asks, new Set(retries.keys()));
  const askedTurns = distinct.reduce((sum, ask) => sum + ask.turnIds.length, 0);
  let budget = MAX_JUDGED_ASKS;
  let judged = 0;

  // Pass one: the topics there are.
  const current = stored.filter((topic) => topic.retiredAt === null);
  const first =
    deps.judge && current.length > 0 && distinct.length > 0
      ? await judgeAsks(
          projectId,
          deps.judge,
          distinct,
          topicOptions(current),
          topicOptionsHash(topicOptions(current)),
          budget,
          deps,
          "topic_placement",
        )
      : null;
  budget -= first?.fresh ?? 0;
  judged += first?.fresh ?? 0;
  const known = new Map<string, string | null>();
  for (const ask of distinct) {
    if (first?.choices.has(ask.hash)) known.set(ask.hash, first.choices.get(ask.hash) ?? null);
    else if (previous.has(ask.hash)) known.set(ask.hash, previous.get(ask.hash)!);
  }
  const passOne = placeAsks(distinct, current, known);

  // New topics from what fits none, retired ones without asks.
  const evolved = await evolveTopics({
    now,
    topics: stored,
    asks: distinct,
    placed: passOne.placed,
    askedTurns,
    name: deps.name ? guardedNamer(projectId, deps.name) : null,
    model: deps.nameModel,
    lastNamingHash: reading?.insights.namingHash ?? null,
    newId: idMaker(projectId, new Set(stored.map((topic) => topic.topicId))),
    fullWindow: !start.capped,
  });

  // Pass two: the topics changed, so the asks are placed again against the new set.
  const finalTopics = evolved.active;
  const second =
    deps.judge && evolved.changed && finalTopics.length > 0 && budget > 0
      ? await judgeAsks(
          projectId,
          deps.judge,
          distinct,
          topicOptions(finalTopics),
          topicOptionsHash(topicOptions(finalTopics)),
          budget,
          deps,
          "topic_placement",
        )
      : null;
  judged += second?.fresh ?? 0;
  const active = new Set(finalTopics.map((topic) => topic.topicId));
  const decided = new Map<string, string | null>();
  const judgedAsks = new Set<string>();
  for (const ask of distinct) {
    if (second?.choices.has(ask.hash)) {
      decided.set(ask.hash, second.choices.get(ask.hash) ?? null);
      judgedAsks.add(ask.hash);
    } else if (evolved.assigned.has(ask.hash)) {
      decided.set(ask.hash, evolved.assigned.get(ask.hash)!);
    } else if (first?.choices.has(ask.hash)) {
      const choice = first.choices.get(ask.hash) ?? null;
      if (choice === null || active.has(choice)) {
        decided.set(ask.hash, choice);
        judgedAsks.add(ask.hash);
      }
    } else if (previous.has(ask.hash) && active.has(previous.get(ask.hash)!)) {
      decided.set(ask.hash, previous.get(ask.hash)!);
    }
  }
  const final = placeAsks(distinct, finalTopics, decided);
  const placement: TopicInsights["placement"] =
    distinct.length === 0
      ? "none"
      : judgedAsks.size === 0
        ? "words"
        : judgedAsks.size === distinct.length
          ? "judged"
          : "mixed";

  const sentiment = await readSentiment(projectId, distinct, deps);
  const placed = placeTurns(
    turns,
    asks,
    retries,
    final.placed,
    sentiment.byHash,
    sentiment.byModel,
  );
  const insights = buildTopicInsights({
    placed,
    topicIds: finalTopics.map((topic) => topic.topicId),
    window: { start: window.from, end: window.to, readFrom: start.from, capped: start.capped },
    selfCorrections: corrections,
    sessionsTrusted: trust.sessions,
    naming: evolved.naming,
    placement,
    namingHash: evolved.namingHash ?? reading?.insights.namingHash ?? null,
  });
  const patterns = await readPatterns(projectId, placed, deps);
  const changedTopics: StoredTopic[] = [...evolved.created, ...evolved.renamed, ...evolved.retired];
  await deps.saveReading(projectId, {
    topics: changedTopics,
    turns: placed.filter((row) => !isModelOnlyTurn(row.turn.id)).map(turnRow),
    insights: withTopicPatterns(insights, patterns),
    model: deps.judge?.model ?? null,
  });
  return {
    turns: turns.length,
    modelOnly: modelOnly.length,
    refused: refused.size,
    capped: start.capped,
    topics: insights.topics.length,
    created: evolved.created.length,
    renamed: evolved.renamed.length,
    retired: evolved.retired.length,
    judged,
    sentimentJudged: sentiment.judged,
    patterns: patterns.size,
    naming: evolved.naming,
    placement,
  };
}

/**
 * Each intent's tool pattern, read from the turns just placed, with the
 * latest signal run's helper tools set aside. Extra to the reading: without
 * a known helper set no pattern is read (the next signal run stores the set
 * and queues the next reading), and a read or a pattern that fails is logged
 * and reported and leaves the patterns out; the reading is saved either way.
 */
async function readPatterns(
  projectId: string,
  placed: readonly PlacedTurn[],
  deps: Pick<AssignTopicsDeps, "loadHelperTools">,
): Promise<Map<string, StoredTopicPattern>> {
  let helpers: readonly string[] | null = null;
  try {
    helpers = await deps.loadHelperTools(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "topic helper tools read failed");
    reportServerException(err, `project:${projectId}`, { operation: "topic_helper_tools" });
    return new Map();
  }
  if (helpers === null) {
    logger.info(
      { project_id: projectId },
      "topic patterns skipped until the helper tools are known",
    );
    return new Map();
  }
  try {
    return topicPatterns({ placed, helpers: new Set(helpers) });
  } catch (err) {
    logger.error({ err, project_id: projectId, turns: placed.length }, "topic patterns failed");
    reportServerException(err, `project:${projectId}`, { operation: "topic_patterns" });
    return new Map();
  }
}

/** The namer, with a failure logged and reported and read as "no names". */
function guardedNamer(projectId: string, name: Namer): Namer {
  return async (groups) => {
    try {
      const named = await name(groups);
      if (named === null)
        logger.warn({ project_id: projectId, groups: groups.length }, "topic names unusable");
      return named;
    } catch (err) {
      logger.error({ err, project_id: projectId, groups: groups.length }, "topic naming failed");
      reportServerException(err, `project:${projectId}`, { operation: "topic_naming" });
      return null;
    }
  };
}

/**
 * Every turn's place: a retry, no ask, or its ask's topic (or none), with
 * sentiment from the user's own words and whether the engine read it (the
 * asks in `modelRead`) or the lexicon did.
 */
export function placeTurns(
  turns: readonly TopicTurn[],
  asks: ReadonlyMap<string, TurnAskText>,
  retries: ReadonlyMap<string, string>,
  placement: ReadonlyMap<string, string | null>,
  sentiment: ReadonlyMap<string, Sentiment>,
  modelRead: ReadonlySet<string> = new Set(),
): PlacedTurn[] {
  return turns.map((turn) => {
    const ask = asks.get(turn.id);
    const askHash = ask ? hashText(normalizeAsk(ask.text)) : null;
    const read = ask && askHash && isUserWords(ask.source);
    const base = {
      turn,
      source: ask?.source ?? null,
      askHash,
      sentiment: read ? (sentiment.get(askHash) ?? lexiconSentiment(ask.text)) : null,
      sentimentByModel: Boolean(read && modelRead.has(askHash)),
      retryOf: null,
    };
    const retryOf = retries.get(turn.id);
    if (retryOf) return { ...base, verdict: "retry" as const, topicId: null, retryOf };
    if (!ask || !askHash) return { ...base, verdict: "no_ask" as const, topicId: null };
    const topicId = placement.get(askHash) ?? null;
    return { ...base, verdict: topicId ? ("topic" as const) : ("none" as const), topicId };
  });
}

function turnRow(row: PlacedTurn): TurnTopicRow {
  return {
    turnId: row.turn.id,
    topicId: row.topicId,
    verdict: row.verdict,
    askSource: row.source,
    askHash: row.askHash,
    sentiment: row.sentiment,
    startedAt: row.turn.startedAt,
  };
}
