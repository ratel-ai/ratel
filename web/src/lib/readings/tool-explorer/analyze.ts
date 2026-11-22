import { envNumber } from "@/lib/platform/env-number";
import { type CousageOptions, mineCousage } from "@/lib/readings/tool-explorer/cousage";
import {
  countIntentTools,
  createIntentToolStats,
  finishIntentCalls,
  finishIntentChains,
  finishIntentEdges,
  finishIntentFirsts,
  finishIntentTools,
  groupIntents,
  intentUnitOf,
  MIN_INTENT_UNITS,
} from "@/lib/readings/tool-explorer/intents";
import {
  countTurnReliability,
  createReliabilityStats,
  type ErrorInfo,
  finishReliability,
} from "@/lib/readings/tool-explorer/reliability";
import {
  countTurnTiming,
  createTimingStats,
  finishTiming,
} from "@/lib/readings/tool-explorer/timing";
import {
  countTransitions,
  createTransitionStats,
  edgeKey,
  finishTransitions,
} from "@/lib/readings/tool-explorer/transitions";
import type {
  ExplorerEdge,
  ExplorerNode,
  ExplorerResult,
  ExplorerScope,
  ExplorerSet,
  ExplorerSummary,
  ExplorerUnit,
  ExplorerWorkflowCore,
  IntentToolShare,
} from "@/lib/readings/tool-explorer/types";
import { EXPLORER_SUMMARY_VERSION } from "@/lib/readings/tool-explorer/types";
import { createSessionFold, nodeIdOf, unitOfTurn } from "@/lib/readings/tool-explorer/units";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * One pass over closed turns: each turn is counted at once as a turn unit and
 * folded into its session; `finish` counts the sessions, mines both scopes'
 * sets and returns plain data. Pure apart from the fold's memory, which the
 * caps in `units.ts` bound.
 *
 * A turn may arrive with the intents its searches were categorized into
 * (`feed(turn, intentIds)`); then the same counting runs over intents as over
 * tools, and each intent's tool shares are kept. Intent texts are not needed
 * until `finish`, which takes them to name the groups.
 */

/** Edge rows stored per scope, most counted first. */
export const MAX_EDGE_ROWS = Math.floor(envNumber("TOOL_EXPLORER_MAX_EDGE_ROWS", 20_000));
/** Set rows stored per scope, most supported first. */
export const MAX_SET_ROWS = Math.floor(envNumber("TOOL_EXPLORER_MAX_SET_ROWS", 10_000));

export interface ExplorerAnalysisOptions {
  workflows?: readonly ExplorerWorkflowCore[];
  cousage?: Omit<CousageOptions, "workflows">;
  maxEdgeRows?: number;
  maxSetRows?: number;
  minIntentUnits?: number;
}

/** What `finish` needs to name intent groups: the text of each intent seen. */
export type IntentTexts = ReadonlyMap<string, string>;

export interface ExplorerAnalysis {
  /** `errors`: an error step's end event id to what its runtime event carried, for the reliability pass. */
  feed(
    turn: Pick<SignalTurn, "id" | "sessionId" | "steps"> & Partial<Pick<SignalTurn, "lane">>,
    intentIds?: readonly string[],
    errors?: ReadonlyMap<string, ErrorInfo>,
  ): void;
  /** Intent ids the analysis has seen, so the caller can load their texts before `finish`. */
  intentIds(): string[];
  finish(intentTexts?: IntentTexts): ExplorerResult;
}

interface NodeCount {
  calls: number;
  turnUnits: number;
  sessionUnits: number;
}

function cap<T>(rows: readonly T[], max: number): { rows: T[]; truncated: boolean } {
  return rows.length > max
    ? { rows: rows.slice(0, max), truncated: true }
    : { rows: [...rows], truncated: false };
}

export function createExplorerAnalysis(options: ExplorerAnalysisOptions = {}): ExplorerAnalysis {
  const turnStats = createTransitionStats("turn", "tool");
  const sessionStats = createTransitionStats("session", "tool");
  const fold = createSessionFold();
  const nodes = new Map<string, NodeCount>();
  const turnUnits: ExplorerUnit[] = [];
  let turnsScanned = 0;

  // Intents ride the same shapes: a unit whose calls are its intents, and a
  // fold keyed by session like the tools' (bounded by the same caps).
  const turnIntentStats = createTransitionStats("turn", "intent");
  const sessionIntentStats = createTransitionStats("session", "intent");
  const turnIntentTools = createIntentToolStats("turn");
  const sessionIntentTools = createIntentToolStats("session");
  const intentFold = createSessionFold();
  const turnIntentUnits: ExplorerUnit[] = [];
  const seenIntents = new Set<string>();
  let turnsWithIntents = 0;
  const timing = createTimingStats();
  const reliability = createReliabilityStats();

  const node = (id: string): NodeCount => {
    let count = nodes.get(id);
    if (!count) {
      count = { calls: 0, turnUnits: 0, sessionUnits: 0 };
      nodes.set(id, count);
    }
    return count;
  };

  return {
    feed(turn, intentIds = [], errors) {
      turnsScanned += 1;
      const unit = unitOfTurn(turn);
      fold.add(unit);
      const intentUnit = intentUnitOf(unit, intentIds);
      intentFold.add(intentUnit);
      if (intentUnit.calls.length > 0) {
        turnsWithIntents += 1;
        for (const id of intentUnit.items) seenIntents.add(id);
      }
      if (unit.calls.length === 0) return;
      turnUnits.push(unit);
      countTransitions(turnStats, unit);
      countTurnTiming(timing, turn);
      countTurnReliability(reliability, turn, errors);
      for (const step of turn.steps) {
        const id = nodeIdOf(step);
        if (id !== null) node(id).calls += 1;
      }
      for (const id of unit.items) node(id).turnUnits += 1;
      if (intentUnit.calls.length > 0) {
        turnIntentUnits.push(intentUnit);
        countTransitions(turnIntentStats, intentUnit);
        countIntentTools(turnIntentTools, intentUnit.items, unit.items, unit.calls);
      }
    },
    intentIds() {
      return [...seenIntents].sort();
    },
    finish(intentTexts = new Map()) {
      const folded = fold.finish();
      const sessionUnits = folded.units.filter((unit) => unit.calls.length > 0);
      for (const unit of sessionUnits) {
        countTransitions(sessionStats, unit);
        for (const id of unit.items) node(id).sessionUnits += 1;
      }
      const cousageOptions: CousageOptions = { ...options.cousage, workflows: options.workflows };
      const turnSets = mineCousage("turn", "tool", turnUnits, cousageOptions);
      const sessionSets = mineCousage("session", "tool", sessionUnits, cousageOptions);

      // Intents at session scope: a session's intents against the tools that
      // same session called, matched by session id.
      const toolsBySession = new Map(sessionUnits.map((unit) => [unit.sessionId, unit]));
      const intentFolded = intentFold.finish();
      const sessionIntentUnits = intentFolded.units.filter(
        (unit) => unit.calls.length > 0 && toolsBySession.has(unit.sessionId),
      );
      for (const unit of sessionIntentUnits) {
        countTransitions(sessionIntentStats, unit);
        const session = toolsBySession.get(unit.sessionId)!;
        countIntentTools(sessionIntentTools, unit.items, session.items, session.calls);
      }
      const intentCousage = { ...options.cousage };
      const turnIntentSets = mineCousage("turn", "intent", turnIntentUnits, intentCousage);
      const sessionIntentSets = mineCousage("session", "intent", sessionIntentUnits, intentCousage);
      const minIntentUnits = options.minIntentUnits ?? MIN_INTENT_UNITS;
      const intentTools: IntentToolShare[] = [
        ...finishIntentTools(turnIntentTools, minIntentUnits),
        ...finishIntentTools(sessionIntentTools, minIntentUnits),
      ];
      const intentChains = {
        turn: finishIntentChains(turnIntentTools, minIntentUnits),
        session: finishIntentChains(sessionIntentTools, minIntentUnits),
      };
      const intentEdges = {
        turn: finishIntentEdges(turnIntentTools, minIntentUnits),
        session: finishIntentEdges(sessionIntentTools, minIntentUnits),
      };
      const intentFirsts = {
        turn: finishIntentFirsts(turnIntentTools, minIntentUnits),
        session: finishIntentFirsts(sessionIntentTools, minIntentUnits),
      };
      const intentCalls = {
        turn: finishIntentCalls(turnIntentTools, minIntentUnits),
        session: finishIntentCalls(sessionIntentTools, minIntentUnits),
      };

      const edges: ExplorerEdge[] = [];
      const sets: ExplorerSet[] = [];
      const truncated: ExplorerSummary["truncated"] = {
        sessions: folded.truncated || intentFolded.truncated,
        edges: {},
        sets: {},
      };
      const timed = finishTiming(timing);
      const withTiming = (scope: ExplorerScope, scopeEdges: ExplorerEdge[]): ExplorerEdge[] =>
        scopeEdges.map((edge) => {
          if (edge.kind !== "next" || edge.subject !== "tool") return edge;
          const t = timed.pairs[scope].get(edgeKey(edge.a, edge.b));
          return t ? { ...edge, timing: t } : edge;
        });
      const scopes: [ExplorerScope, ExplorerEdge[], ExplorerSet[], boolean][] = [
        [
          "turn",
          [
            ...withTiming("turn", finishTransitions(turnStats)),
            ...finishTransitions(turnIntentStats),
          ],
          [...turnSets.sets, ...turnIntentSets.sets],
          turnSets.truncated || turnIntentSets.truncated,
        ],
        [
          "session",
          [
            ...withTiming("session", finishTransitions(sessionStats)),
            ...finishTransitions(sessionIntentStats),
          ],
          [...sessionSets.sets, ...sessionIntentSets.sets],
          sessionSets.truncated || sessionIntentSets.truncated,
        ],
      ];
      for (const [scope, scopeEdges, scopeSets, minerTruncated] of scopes) {
        const e = cap(scopeEdges, options.maxEdgeRows ?? MAX_EDGE_ROWS);
        const s = cap(scopeSets, options.maxSetRows ?? MAX_SET_ROWS);
        edges.push(...e.rows);
        sets.push(...s.rows);
        if (e.truncated) truncated.edges[scope] = true;
        // The miner's own cap counts too: sets it never saw are missing like cut rows are.
        if (s.truncated || minerTruncated) truncated.sets[scope] = true;
      }

      const unitsOfIntent = new Map<string, number>();
      for (const share of intentTools)
        if (share.scope === "turn") unitsOfIntent.set(share.intentId, share.intentUnits);
      const intentGroups = groupIntents(
        [...seenIntents].map((id) => ({
          id,
          text: intentTexts.get(id) ?? "",
          units: unitsOfIntent.get(id) ?? 0,
        })),
      );

      const nodeRows: ExplorerNode[] = [...nodes]
        .map(([id, count]) => {
          const t = timed.nodes.get(id);
          return {
            id,
            subject: "tool" as const,
            ...count,
            ...(t
              ? {
                  totalMs: t.totalMs,
                  medianMs: t.medianMs,
                  timedCalls: t.timedCalls,
                  errorCalls: t.errorCalls,
                }
              : {}),
          };
        })
        .sort((x, y) => y.calls - x.calls || (x.id < y.id ? -1 : 1));

      return {
        edges,
        sets,
        intentTools,
        summary: {
          version: EXPLORER_SUMMARY_VERSION,
          units: {
            turn: { units: turnSets.units, multiUnits: turnSets.multiUnits },
            session: { units: sessionSets.units, multiUnits: sessionSets.multiUnits },
          },
          nodes: nodeRows,
          intentUnits: { turn: turnIntentUnits.length, session: sessionIntentUnits.length },
          ...(intentGroups.length > 0 ? { intentGroups } : {}),
          intentChains,
          intentEdges,
          intentFirsts,
          intentCalls,
          reliability: finishReliability(reliability),
          truncated,
        },
        turnsScanned,
        sessionsScanned: folded.units.length,
        turnsWithIntents,
      };
    },
  };
}

/** The analysis over turns already in memory, for tests and replays. */
export function analyzeExplorerTurns(
  turns: readonly (Pick<SignalTurn, "id" | "sessionId" | "steps"> & {
    intentIds?: readonly string[];
  })[],
  options: ExplorerAnalysisOptions = {},
  intentTexts?: IntentTexts,
): ExplorerResult {
  const analysis = createExplorerAnalysis(options);
  for (const turn of turns) analysis.feed(turn, turn.intentIds);
  return analysis.finish(intentTexts);
}
