import type { ClosedTurnPage, listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import type { StepDraft, TurnEndedBy, TurnSource } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import {
  askedAgainSteps,
  detectInTurn,
  readAskedAgain,
  readsTurn,
  type SelfCorrection,
  type SelfCorrectionTrust,
  type SelfCorrectionTurn,
  trustOf,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import {
  createIssueStats,
  type IssueEvent,
} from "@/lib/readings/trace-signals/self-corrections/issues";
import { patternOf, plainKindOf } from "@/lib/readings/trace-signals/self-corrections/kinds";
import {
  type CapturedReply,
  type PhraseCorrection,
  phraseCorrections,
} from "@/lib/readings/trace-signals/self-corrections/replies";
import {
  behaviourRow,
  type CorrectionRowDraft,
  phraseRow,
} from "@/lib/readings/trace-signals/self-corrections/rows";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import type { DetectedSignal, SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * Self-corrections inside a signal run (`compute_trace_signals`): every closed
 * turn ending in the run's window, read under the run-boundary rules
 * (`trustOf`), gives its behaviour self-corrections (`detect.ts`) and the
 * phrases in its captured replies (`replies.ts`); the same user's next turn
 * says whether they asked again. The window's rows in
 * `trace_self_corrections` are replaced with what was read, and the
 * `self_correcting` issues are found (`issues.ts`).
 *
 * Turns are walked a page at a time like the signal run's own walk, under the
 * same wall-clock budget (a `TimeBudgetError` propagates). Whether a user
 * asked again needs their next turn, which may be on a later page, so each
 * read turn is kept in compact form (`askedAgainSteps`) until the walk ends.
 *
 * Self-contained on purpose: the compute job calls it once, after its own
 * reading, and merges the issues into what it persists.
 */

/** What one page of turns needs beyond its steps, read in one go. */
export interface PageFacts {
  /** Captured replies, by turn id. */
  replies: ReadonlyMap<string, readonly CapturedReply[]>;
  /** `trace_events` ids of calls whose captured result was empty. */
  emptyEvents: ReadonlySet<string>;
  /** The task each turn belongs to (`trace_turns.workflow_id`), by turn id. */
  workflows: ReadonlyMap<string, string>;
  /** The topic each turn is in (`trace_turn_topics`), by turn id. */
  topics: ReadonlyMap<string, string>;
  /** The user's own words per turn, when captured. Compared in memory, never stored. */
  asks: ReadonlyMap<string, string>;
}

/** What a run stores in `trace_signal_runs.summary.selfCorrections`. Counts only. */
export interface StoredSelfCorrections {
  version: 1;
  /** Which runs and sessions the reading trusted. */
  trust: SelfCorrectionTrust;
  /** Turns read in the window. */
  turns: number;
  /** Of those, turns with at least one captured reply: phrases are measured only on them. */
  turnsWithReplies: number;
  /** Rows written. */
  events: number;
}

export interface SelfCorrectionRunDeps {
  listPage: typeof listClosedTurnsPage;
  /** The window's run basis (`run-basis.ts`), as the signal run decides it. */
  loadBasis: (projectId: string, window: { start: Date; end: Date }) => Promise<RunBasis>;
  loadPageFacts: (projectId: string, turns: readonly SignalTurn[]) => Promise<PageFacts>;
  /** Topic names by id, for the unanswered fix. */
  loadTopicNames: (projectId: string) => Promise<ReadonlyMap<string, string>>;
  /** Replaces the rows of the turns ending in `range`; returns rows written. */
  replaceRows: (
    projectId: string,
    range: { from: Date; to: Date },
    rows: readonly CorrectionRowDraft[],
  ) => Promise<number>;
  now: () => Date;
  timeBudgetMs: number;
  /** Epoch ms the budget counts from: the job's start, so this shares the run's budget. */
  startedAt: number;
  pageSize: number;
  floors: Floors["self_correcting"];
}

export interface SelfCorrectionRunInput {
  window: { start: Date; end: Date };
  /** This run's tasks by id, with their typical order. */
  tasks: ReadonlyMap<string, readonly string[]>;
}

export interface SelfCorrectionRunResult {
  signals: DetectedSignal[];
  /** `self_correcting` once the reading could read runs; empty when runs are mixed together. */
  measured: Set<SignalKind>;
  stored: StoredSelfCorrections;
}

/** A read turn, kept until every turn is read: what asking again, the rows and the issues need. */
interface CompactTurn extends SelfCorrectionTurn {
  id: string;
  workflowId: string | null;
  topicId: string | null;
  turnSource: TurnSource;
  endedBy?: TurnEndedBy | null;
  tools: string[];
  events: IssueEvent[];
  /** Whether the turn's last call came back empty, for the pattern of an `asked_again`. */
  lastCallEmpty: boolean;
}

function emptyAt(step: StepDraft | undefined, empty: ReadonlySet<string>): boolean {
  if (!step) return false;
  return (
    empty.has(step.traceEventId) ||
    (step.endTraceEventId !== null && empty.has(step.endTraceEventId))
  );
}

function issueEvent(
  steps: readonly StepDraft[],
  empty: ReadonlySet<string>,
  input: {
    kind: string;
    phraseCategory: string | null;
    tool: string | null;
    toolOutcome: string | null;
    toolOrdinal: number | null;
    ordinal: number | null;
  },
): IssueEvent | null {
  const plain = plainKindOf(input.kind, input.phraseCategory);
  if (!plain) return null;
  const before = steps.find((step) => step.ordinal === input.toolOrdinal);
  const points = steps.find((step) => step.ordinal === (input.toolOrdinal ?? input.ordinal));
  return {
    plain,
    tool: input.tool,
    pattern: patternOf({
      tool: input.tool,
      toolOutcome: input.toolOutcome,
      toolEmpty: emptyAt(before, empty),
    }),
    traceEventId: points?.traceEventId ?? null,
  };
}

const fromBehaviour = (
  steps: readonly StepDraft[],
  empty: ReadonlySet<string>,
  event: SelfCorrection,
) => issueEvent(steps, empty, { ...event, phraseCategory: null });

const fromPhrase = (
  steps: readonly StepDraft[],
  empty: ReadonlySet<string>,
  phrase: PhraseCorrection,
) =>
  issueEvent(steps, empty, {
    kind: "phrase",
    phraseCategory: phrase.category,
    tool: phrase.tool,
    toolOutcome: phrase.toolOutcome,
    toolOrdinal: phrase.toolOrdinal,
    ordinal: null,
  });

function readTurn(turn: SignalTurn, facts: PageFacts, rows: CorrectionRowDraft[]): CompactTurn {
  const workflowId = facts.workflows.get(turn.id) ?? null;
  const rowTurn = { id: turn.id, endedAt: turn.endedAt, workflowId };
  const behaviour = detectInTurn(turn.steps);
  const phrases = phraseCorrections(turn.steps, facts.replies.get(turn.id) ?? []);
  rows.push(
    ...behaviour.map((event) => behaviourRow(rowTurn, turn.steps, event)),
    ...phrases.map((phrase) => phraseRow(rowTurn, phrase)),
  );
  const events = [
    ...behaviour.map((event) => fromBehaviour(turn.steps, facts.emptyEvents, event)),
    ...phrases.map((phrase) => fromPhrase(turn.steps, facts.emptyEvents, phrase)),
  ].filter((event): event is IssueEvent => event !== null);
  const calls = turn.steps.filter((step) => nodeIdOf(step) !== null);
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    endUserKey: turn.endUserKey ?? null,
    turnSource: turn.turnSource,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    endedBy: turn.endedBy ?? null,
    askText: facts.asks.get(turn.id) ?? null,
    steps: askedAgainSteps(turn.steps),
    workflowId,
    topicId: facts.topics.get(turn.id) ?? null,
    tools: [...new Set(calls.map((step) => nodeIdOf(step)!))],
    events,
    lastCallEmpty: emptyAt(calls.at(-1), facts.emptyEvents),
  };
}

/** Run one reading of self-corrections for the window. Throws `TimeBudgetError` on overrun. */
export async function recordSelfCorrections(
  projectId: string,
  input: SelfCorrectionRunInput,
  deps: SelfCorrectionRunDeps,
): Promise<SelfCorrectionRunResult> {
  const range = { from: input.window.start, to: input.window.end };
  const trust = trustOf(await deps.loadBasis(projectId, input.window));
  const rows: CorrectionRowDraft[] = [];
  const turns: CompactTurn[] = [];
  let turnsWithReplies = 0;

  if (trust.runs !== "none") {
    const walk = {
      pageSize: deps.pageSize,
      startedAt: deps.startedAt,
      now: deps.now,
      timeBudgetMs: deps.timeBudgetMs,
    };
    await walkClosedTurnPages(
      deps.listPage,
      projectId,
      range,
      walk,
      async (page: ClosedTurnPage) => {
        const read = page.turns.filter((turn) => readsTurn(trust, turn.turnSource));
        if (read.length === 0) return;
        const facts = await deps.loadPageFacts(projectId, read);
        for (const turn of read) {
          if ((facts.replies.get(turn.id)?.length ?? 0) > 0) turnsWithReplies += 1;
          turns.push(readTurn(turn, facts, rows));
        }
      },
    );
  }

  // Asking again is known only now that every turn is read: its rows and issue events join the rest.
  const asked = readAskedAgain(turns, trust).map((reading, index) => {
    const turn = turns[index]!;
    const event = reading?.event;
    if (!event) return null;
    rows.push(
      behaviourRow(
        { id: turn.id, endedAt: turn.endedAt, workflowId: turn.workflowId },
        turn.steps,
        event,
      ),
    );
    const points = turn.steps.find((step) => step.ordinal === (event.toolOrdinal ?? event.ordinal));
    return {
      plain: "asked_again",
      tool: event.tool,
      pattern: patternOf({
        tool: event.tool,
        toolOutcome: event.toolOutcome,
        toolEmpty: turn.lastCallEmpty,
      }),
      traceEventId: points?.traceEventId ?? null,
    } satisfies IssueEvent;
  });

  const written = await deps.replaceRows(projectId, range, rows);
  const stored: StoredSelfCorrections = {
    version: 1,
    trust,
    turns: turns.length,
    turnsWithReplies,
    events: written,
  };
  if (trust.runs === "none") return { signals: [], measured: new Set(), stored };

  const issues = createIssueStats();
  turns.forEach((turn, index) => {
    const again = asked[index];
    issues.add({ ...turn, turnId: turn.id, events: again ? [...turn.events, again] : turn.events });
  });
  const topics = turns.some((turn) => turn.topicId !== null)
    ? await deps.loadTopicNames(projectId)
    : new Map<string, string>();
  const found = issues.finish({
    tasks: input.tasks,
    topics,
    floors: deps.floors ?? DEFAULT_FLOORS.self_correcting,
  });
  return { signals: [...found.signals], measured: new Set(found.measured), stored };
}
