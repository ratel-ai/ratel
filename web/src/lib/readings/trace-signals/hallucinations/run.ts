import type { ClosedTurnPage, listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { toolName } from "@/lib/readings/trace-signals/hallucinations/action-class";
import { claimsCompletion } from "@/lib/readings/trace-signals/hallucinations/claims";
import {
  detectHallucinations,
  type Finding,
  requestedOf,
  unrecoveredActingFailure,
} from "@/lib/readings/trace-signals/hallucinations/detect";
import {
  GROUP_OF,
  HALLUCINATION_KINDS,
  type HallucinationKind,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import type {
  CallFacts,
  HallucinationRowDraft,
} from "@/lib/readings/trace-signals/hallucinations/run-queries";
import { readsTurn, trustOf } from "@/lib/readings/trace-signals/self-corrections/detect";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { stepCalls, stepEventIds } from "@/lib/readings/trace-signals/step-calls";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * One hallucination reading of a signal run's window: every closed turn the
 * run trusts, a page at a time, through the rules (`detect.ts`), then the two
 * guards that need the whole window, then one replace of the window's rows.
 *
 * Behind its switch (`hallucinationDetection` for the project's
 * organization, `gate.ts`): off, the reading loads nothing and writes
 * nothing. It shares the signal run's time budget and writes only after its
 * walk, so an overrun leaves the window's earlier rows as they were.
 *
 * Text (error messages, replies) is read in memory per page and dropped; a
 * row keeps closed values and ids.
 */

/**
 * A requested name the runtime maps to one tool, steadily: across at least
 * `ALIAS_MIN_SESSIONS` sessions and `ALIAS_MIN_CALLS` calls, at least
 * `ALIAS_MIN_WORKED` of them worked. The agent uses it on purpose and the
 * runtime knows it (an operation alias, a renamed tool), so it is a naming
 * mismatch to tidy, not a made-up tool, and it is left out of the findings.
 * A pair that fails (a read rerouted to a create that never works) stays.
 */
const ALIAS_MIN_SESSIONS = 3;
const ALIAS_MIN_CALLS = 5;
const ALIAS_MIN_WORKED = 0.9;

/** A name pair read as an alias: ids and counts only. */
export interface StoredAlias {
  requestedToolId: string;
  toolId: string;
  calls: number;
  worked: number;
  sessions: number;
}

export interface StoredHallucinations {
  /** Turns the reading read. */
  turns: number;
  /** Turns with at least one finding. */
  turnsAffected: number;
  findings: number;
  byKind: Record<HallucinationKind, number>;
  /** Requested names the runtime steadily maps to a tool: naming mismatches, not findings. */
  aliases?: StoredAlias[];
}

export interface HallucinationRunDeps {
  /** The switch: asked once, before anything is loaded. */
  enabled: (projectId: string) => Promise<boolean>;
  listPage: typeof listClosedTurnsPage;
  /** The window's run basis (`run-basis.ts`), as the signal run decides it. */
  loadBasis: (projectId: string, window: { start: Date; end: Date }) => Promise<RunBasis>;
  loadCallFacts: (projectId: string, eventIds: readonly string[]) => Promise<CallFacts>;
  /** Names and ids the catalog holds; null when the project has no catalog to check against. */
  loadCatalog: (projectId: string) => Promise<ReadonlySet<string> | null>;
  /** The agent's reply in each of these turns (turn id and its first steps' event ids), where content is captured. */
  loadReplyTexts: (
    projectId: string,
    turns: ReadonlyArray<readonly [string, readonly string[]]>,
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * The window's turns a model read as a false success from the person's next
   * message (the outcome reading runs first in the same job), with each one's
   * end. Absent: that evidence is not read.
   */
  loadFalseSuccessTurns?: (
    projectId: string,
    range: { from: Date; to: Date },
  ) => Promise<ReadonlyMap<string, Date>>;
  replaceRows: (
    projectId: string,
    range: { from: Date; to: Date },
    rows: readonly HallucinationRowDraft[],
  ) => Promise<number>;
  now: () => Date;
  timeBudgetMs: number;
  /** Epoch ms the budget counts from: the job's start, so this shares the run's budget. */
  startedAt: number;
  pageSize: number;
}

export interface HallucinationRunInput {
  window: { start: Date; end: Date };
}

export interface HallucinationRunResult {
  stored: StoredHallucinations;
}

/** The events of a turn's calls: a call's start, and its end when it has one. */
const callEvents = (turn: SignalTurn): string[] =>
  stepCalls(turn.steps).flatMap(({ step }) => stepEventIds(step));

/**
 * Run one reading for the window; null when the switch is off. Throws
 * `TimeBudgetError` on overrun, before anything is written.
 */
export async function recordHallucinations(
  projectId: string,
  input: HallucinationRunInput,
  deps: HallucinationRunDeps,
): Promise<HallucinationRunResult | null> {
  if (!(await deps.enabled(projectId).catch(() => false))) return null;
  const range = { from: input.window.start, to: input.window.end };
  const trust = trustOf(await deps.loadBasis(projectId, input.window));
  const catalog = await deps.loadCatalog(projectId);
  const falseSuccess =
    (await deps.loadFalseSuccessTurns?.(projectId, range)) ?? new Map<string, Date>();
  const found: Array<Finding & { turnId: string }> = [];
  /** Every tool that worked under its own name in the window (compared by name, and by id). */
  const ran = new Set<string>();
  const worked = new Set<string>();
  /** Every call that asked for another name than the tool that ran, by pair. */
  const pairs = new Map<
    string,
    {
      requestedToolId: string;
      toolId: string;
      calls: number;
      worked: number;
      sessions: Set<string>;
    }
  >();
  let turns = 0;

  const readPage = async (page: readonly SignalTurn[]) => {
    const facts = await deps.loadCallFacts(projectId, page.flatMap(callEvents));
    // Replies only for the turns a false "done" could be read in: an acting call failed and nothing made up for it,
    // or the person's next message says the work was not done.
    const claimable = page.filter(
      (turn) => unrecoveredActingFailure(turn.steps) !== null || falseSuccess.has(turn.id),
    );
    const replies =
      claimable.length > 0
        ? await deps.loadReplyTexts(
            projectId,
            claimable.map(
              (turn) => [turn.id, turn.steps.slice(0, 3).map((step) => step.traceEventId)] as const,
            ),
          )
        : new Map<string, string>();
    for (const turn of page) {
      turns += 1;
      for (const step of turn.steps) {
        const node = nodeIdOf(step);
        if (node === null) continue;
        // Only a call that worked shows the name is real: a failed one may be the made-up name itself.
        if (step.outcome === "ok") {
          ran.add(toolName(node));
          worked.add(node);
        }
        const asked = requestedOf(step, facts.requested);
        if (asked !== null && toolName(asked) !== toolName(node)) {
          const key = `${asked}\u0000${node}`;
          const pair = pairs.get(key) ?? {
            requestedToolId: asked,
            toolId: node,
            calls: 0,
            worked: 0,
            sessions: new Set<string>(),
          };
          pair.calls += 1;
          if (step.outcome === "ok") pair.worked += 1;
          pair.sessions.add(turn.sessionId);
          pairs.set(key, pair);
        }
      }
      const findings = detectHallucinations({
        steps: turn.steps,
        errors: facts.errors,
        requested: facts.requested,
        noSuchTool: facts.noSuchTool,
        catalog,
        reply: replies.get(turn.id) ?? null,
      });
      for (const finding of findings) found.push({ ...finding, turnId: turn.id });
      // The reply says "done", and the person's next message says it was not: on the turn's last call, unless the
      // rules already found a false "done" here. Without the reply nothing was claimed that can be shown false.
      const endedAt = falseSuccess.get(turn.id);
      const last = turn.steps.findLast((step) => nodeIdOf(step) !== null);
      if (
        endedAt &&
        last &&
        claimsCompletion(replies.get(turn.id)) &&
        !findings.some((finding) => GROUP_OF[finding.kind] === "completion")
      ) {
        found.push({
          turnId: turn.id,
          kind: "done_but_person_says_not",
          stepOrdinal: last.ordinal,
          toolId: nodeIdOf(last)!,
          requestedToolId: null,
          evidence: "person_says_not_done",
          repeats: 1,
          worked: false,
          occurredAt: endedAt,
        });
      }
    }
  };

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
        if (read.length > 0) await readPage(read);
      },
    );
  }

  // The guards that need the whole window: a requested name that worked under its own name is an alias the
  // runtime knows, not a made-up tool; a tool whose error said "unknown tool" but that worked elsewhere exists.
  const aliases: StoredAlias[] = [...pairs.values()]
    .filter(
      (pair) =>
        pair.sessions.size >= ALIAS_MIN_SESSIONS &&
        pair.calls >= ALIAS_MIN_CALLS &&
        pair.worked / pair.calls >= ALIAS_MIN_WORKED,
    )
    .map((pair) => ({
      requestedToolId: pair.requestedToolId,
      toolId: pair.toolId,
      calls: pair.calls,
      worked: pair.worked,
      sessions: pair.sessions.size,
    }))
    .sort((a, b) => b.calls - a.calls || a.requestedToolId.localeCompare(b.requestedToolId));
  const alias = new Set(aliases.map((entry) => `${entry.requestedToolId}\u0000${entry.toolId}`));
  const kept = found.filter((finding) => {
    if (finding.requestedToolId !== null && ran.has(toolName(finding.requestedToolId)))
      return false;
    // A name the runtime steadily maps to this tool, and that works there: an alias, not a made-up tool.
    if (
      finding.requestedToolId !== null &&
      alias.has(`${finding.requestedToolId}\u0000${finding.toolId}`)
    )
      return false;
    if (
      finding.kind === "unknown_tool" &&
      finding.evidence === "error_names_tool" &&
      worked.has(finding.toolId)
    )
      return false;
    return true;
  });

  await deps.replaceRows(
    projectId,
    range,
    kept.map(
      ({
        turnId,
        kind,
        stepOrdinal,
        toolId,
        requestedToolId,
        evidence,
        repeats,
        worked: ok,
        occurredAt,
      }) => ({
        turnId,
        stepOrdinal,
        kind,
        toolId,
        requestedToolId,
        evidence,
        repeats,
        worked: ok,
        occurredAt,
      }),
    ),
  );
  const byKind = Object.fromEntries(
    HALLUCINATION_KINDS.map((kind) => [
      kind,
      kept.filter((finding) => finding.kind === kind).length,
    ]),
  ) as Record<HallucinationKind, number>;
  return {
    stored: {
      turns,
      turnsAffected: new Set(kept.map((finding) => finding.turnId)).size,
      findings: kept.length,
      byKind,
      aliases,
    },
  };
}
