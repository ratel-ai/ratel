import type { EntryStats, ProjectStats } from "@/lib/readings/trace-signals/signals/accumulators";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { JOURNEY_OTHER_ID, type StoredJourney } from "@/lib/readings/trace-signals/signals/journey";
import type { PairStats } from "@/lib/readings/trace-signals/signals/pairs";
import { siblingKey } from "@/lib/readings/trace-signals/signals/pairs";
import type { StoredPrerequisites } from "@/lib/readings/trace-signals/signals/prerequisites";
import { type DetectedSignal, signalKey } from "@/lib/readings/trace-signals/signals/types";
import type {
  FlowEdge,
  FlowJourney,
  FlowJourneyFlag,
  FlowJourneyTool,
  FlowModel,
  FlowNode,
  FlowPrerequisites,
  FlowTint,
  SignalKind,
} from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";

/**
 * The flow map's data: a `search` source node, the busiest tools, one `quiet`
 * plate folding the rest, and pick / sequence / sibling edges with counts and
 * confidence. Built by the run and stored in its summary with signals referenced
 * by key (`kind:subject_key`), because a new signal has no row id until the run
 * persists it. {@link flowView} resolves keys to ids and derives the tints from
 * the signals that are open when the page renders, so muting or fixing a signal
 * repaints the map without a rerun. Layout is the UI's (`flow-layout.ts`).
 */

export const FLOW_TOOL_NODES = 40;
const FLOW_DEAD_NODES = 3;
const SEQUENCE_EDGES = 30;
const SIBLING_EDGES = 10;
const MIN_EDGE_TURNS = 3;
/** A tool this busy, failing rarely and found first try, is tinted healthy when it has no open signal. */
const HEALTHY_MIN_INVOCATIONS = 20;

export interface StoredFlowNode {
  id: string;
  kind: FlowNode["kind"];
  entryId: string;
  invocations: number;
  impressions: number;
  healthy: boolean;
  dead: boolean;
  signalKeys: string[];
  quietCount?: number;
}

export interface StoredFlowEdge {
  from: string;
  to: string;
  kind: FlowEdge["kind"];
  count: number;
  confidence: number;
  signalKeys: string[];
}

export interface StoredFlow {
  nodes: StoredFlowNode[];
  edges: StoredFlowEdge[];
  totalTools: number;
  /** Turns call by call (`journey.ts`). Additive: absent on runs stored before it. */
  journey?: StoredJourney;
  /** What each tool needs first, across a session (`prerequisites.ts`). Additive: absent on runs stored before it. */
  prerequisites?: StoredPrerequisites;
}

function nodeId(entry: EntryStats): string {
  return entry.targetType === "skill" ? `skill:${entry.id}` : entry.id;
}

function isHealthy(entry: EntryStats): boolean {
  if (entry.invocations < HEALTHY_MIN_INVOCATIONS) return false;
  if (entry.errors / entry.invocations >= 0.1) return false;
  return entry.offeredTurns === 0 || entry.laterSearchTurns / entry.offeredTurns < 0.2;
}

const NODE_KINDS: ReadonlySet<SignalKind> = new Set([
  "first_try_miss",
  "buried_tool",
  "magnet",
  "error_loop",
  "no_follow_through",
  "latency_outlier",
  "repeat_invoke",
  "sibling_confusion",
  "sequence_chain",
  "dead_tool",
  "tool_switch",
  "empty_result",
  "unknown_tool",
  "blocked_action",
  "identical_retry",
  "wait_heavy",
]);

function keysFor(signals: readonly DetectedSignal[], id: string, dead: boolean): string[] {
  return signals
    .filter(
      (s) =>
        NODE_KINDS.has(s.kind) && s.subjectIds.includes(id) && (s.kind !== "dead_tool" || dead),
    )
    .map(signalKey);
}

export function buildFlow(
  stats: ProjectStats,
  pairs: PairStats,
  signals: readonly DetectedSignal[],
  catalogTools: number,
): StoredFlow {
  const deadIds =
    signals.find((s) => s.kind === "dead_tool")?.subjectIds.slice(0, FLOW_DEAD_NODES) ?? [];
  const seen = [...stats.entries.values()]
    .filter((e) => e.invocations > 0 || e.impressions > 0)
    .sort(
      (a, b) =>
        b.invocations - a.invocations || b.impressions - a.impressions || (a.key < b.key ? -1 : 1),
    );
  // Tools a node-level signal names are drawn first: a magnet is by definition
  // rarely run, so ranking by invocations alone folds the very tool a card
  // points at into the quiet plate. The rest fill by busyness, and the map keeps
  // busyness order either way.
  const capacity = FLOW_TOOL_NODES - deadIds.length;
  const flagged = seen.filter((e) => keysFor(signals, e.id, false).length > 0).slice(0, capacity);
  const picked = new Set(flagged.map((e) => e.key));
  for (const entry of seen) {
    if (picked.size >= capacity) break;
    picked.add(entry.key);
  }
  const shown = seen.filter((e) => picked.has(e.key));
  const folded = seen.filter((e) => !picked.has(e.key));
  const toolNodes: StoredFlowNode[] = shown.map((entry) => ({
    id: nodeId(entry),
    kind: entry.targetType,
    entryId: entry.id,
    invocations: entry.invocations,
    impressions: entry.impressions,
    healthy: isHealthy(entry),
    dead: false,
    signalKeys: keysFor(signals, entry.id, false),
  }));
  const deadNodes: StoredFlowNode[] = deadIds.map((id) => ({
    id,
    kind: "tool",
    entryId: id,
    invocations: 0,
    impressions: 0,
    healthy: false,
    dead: true,
    signalKeys: keysFor(signals, id, true),
  }));
  const search: StoredFlowNode = {
    id: "search",
    kind: "search",
    entryId: "search",
    invocations: 0,
    impressions: 0,
    healthy: false,
    dead: false,
    signalKeys: signals
      .filter((s) => s.kind === "padding_share" || s.kind === "abandoned_search")
      .map(signalKey),
  };
  const quiet: StoredFlowNode[] =
    folded.length === 0
      ? []
      : [
          {
            id: "quiet",
            kind: "quiet",
            entryId: "quiet",
            invocations: folded.reduce((sum, e) => sum + e.invocations, 0),
            impressions: folded.reduce((sum, e) => sum + e.impressions, 0),
            healthy: false,
            dead: false,
            signalKeys: [],
            quietCount: folded.length,
          },
        ];
  const included = new Set(shown.filter((e) => e.targetType === "tool").map((e) => e.id));
  return {
    nodes: [search, ...toolNodes, ...deadNodes, ...quiet],
    edges: [
      ...pickEdges(shown, folded, signals),
      ...sequenceEdges(stats, pairs, included, signals),
      ...siblingEdges(pairs, included, signals),
    ],
    totalTools: Math.max(catalogTools, seen.filter((e) => e.targetType === "tool").length),
  };
}

function pickEdges(
  shown: readonly EntryStats[],
  folded: readonly EntryStats[],
  signals: readonly DetectedSignal[],
): StoredFlowEdge[] {
  const edges = shown
    .filter((entry) => entry.offeredTurns > 0)
    .map((entry) => ({
      from: "search",
      to: nodeId(entry),
      kind: "pick" as const,
      count: entry.offeredTurns,
      confidence: round4(entry.offeredTurns / Math.max(1, entry.invokeTurns)),
      signalKeys: signals
        .filter(
          (s) =>
            (s.kind === "magnet" || s.kind === "buried_tool") && s.subjectIds.includes(entry.id),
        )
        .map(signalKey),
    }));
  const quietPicks = folded.reduce((sum, e) => sum + e.offeredTurns, 0);
  const quietTurns = folded.reduce((sum, e) => sum + e.invokeTurns, 0);
  if (quietPicks === 0) return edges;
  return [
    ...edges,
    {
      from: "search",
      to: "quiet",
      kind: "pick",
      count: quietPicks,
      confidence: round4(quietPicks / Math.max(1, quietTurns)),
      signalKeys: [],
    },
  ];
}

function sequenceEdges(
  stats: ProjectStats,
  pairs: PairStats,
  included: ReadonlySet<string>,
  signals: readonly DetectedSignal[],
): StoredFlowEdge[] {
  return [...pairs.ordered]
    .map(([key, pair]) => ({ key, pair, ends: key.split(">") as [string, string] }))
    .filter(
      ({ pair, ends }) =>
        pair.n >= MIN_EDGE_TURNS && included.has(ends[0]) && included.has(ends[1]),
    )
    .sort((a, b) => b.pair.n - a.pair.n || (a.key < b.key ? -1 : 1))
    .slice(0, SEQUENCE_EDGES)
    .map(({ key, pair, ends }) => ({
      from: ends[0],
      to: ends[1],
      kind: "sequence" as const,
      count: pair.n,
      confidence: round4(
        pair.n / Math.max(1, stats.entries.get(`tool:${ends[0]}`)?.invokeTurns ?? 0),
      ),
      signalKeys: signals
        .filter((s) => s.kind === "sequence_chain" && s.subjectKey === key)
        .map(signalKey),
    }));
}

function siblingEdges(
  pairs: PairStats,
  included: ReadonlySet<string>,
  signals: readonly DetectedSignal[],
): StoredFlowEdge[] {
  return [...pairs.siblings]
    .map(([key, pair]) => ({ key, pair, ends: key.split("|") as [string, string] }))
    .filter(
      ({ pair, ends }) =>
        pair.swaps >= MIN_EDGE_TURNS && included.has(ends[0]) && included.has(ends[1]),
    )
    .sort((a, b) => b.pair.swaps - a.pair.swaps || (a.key < b.key ? -1 : 1))
    .slice(0, SIBLING_EDGES)
    .map(({ pair, ends }) => ({
      from: ends[0],
      to: ends[1],
      kind: "sibling" as const,
      count: pair.swaps,
      confidence: round4(pair.swaps / Math.max(1, pair.decisionTurns)),
      signalKeys: signals
        .filter(
          (s) => s.kind === "sibling_confusion" && s.subjectKey === siblingKey(ends[0], ends[1]),
        )
        .map(signalKey),
    }));
}

/* - Read side --------------------------------------------------------------- */

/** An open signal as the flow needs it. */
export interface OpenSignalRef {
  key: string;
  id: string;
  kind: SignalKind;
}

const MAGNET_KINDS: ReadonlySet<SignalKind> = new Set(["magnet"]);
const BURIED_KINDS: ReadonlySet<SignalKind> = new Set([
  "buried_tool",
  "first_try_miss",
  "sibling_confusion",
]);

function tintOf(kinds: readonly SignalKind[], healthy: boolean, dead: boolean): FlowTint {
  if (dead) return "dead";
  if (kinds.some((k) => MAGNET_KINDS.has(k))) return "magnet";
  if (kinds.some((k) => BURIED_KINDS.has(k))) return "buried";
  if (kinds.length === 0 && healthy) return "healthy";
  return "none";
}

/** The stored flow with signal keys resolved to open signal ids, tints and labels. */
export function flowView(
  stored: StoredFlow,
  open: readonly OpenSignalRef[],
  names: ReadonlyMap<string, string>,
): FlowModel {
  const byKey = new Map(open.map((s) => [s.key, s]));
  const resolve = (keys: readonly string[]) =>
    keys.map((k) => byKey.get(k)).filter((s) => s !== undefined);
  const kindsById = new Map<string, SignalKind[]>();
  const nodes: FlowNode[] = stored.nodes.map((node) => {
    const refs = resolve(node.signalKeys);
    const kinds = refs.map((r) => r.kind);
    kindsById.set(node.id, kinds);
    const label =
      node.kind === "search"
        ? "Search"
        : node.kind === "quiet"
          ? `and ${node.quietCount ?? 0} quiet ${node.quietCount === 1 ? "tool" : "tools"}`
          : (names.get(node.entryId) ?? node.entryId);
    return {
      id: node.id,
      kind: node.kind,
      label,
      invocations: node.invocations,
      impressions: node.impressions,
      tint:
        node.kind === "tool" || node.kind === "skill"
          ? tintOf(kinds, node.healthy, node.dead)
          : "none",
      signalIds: refs.map((r) => r.id),
      ...(node.quietCount !== undefined ? { quietCount: node.quietCount } : {}),
    };
  });
  const tintById = new Map(nodes.map((n) => [n.id, n.tint]));
  const edges: FlowEdge[] = stored.edges.map((edge) => {
    const refs = resolve(edge.signalKeys);
    const tint: FlowTint =
      edge.kind === "pick"
        ? (tintById.get(edge.to) ?? "none")
        : edge.kind === "sibling" && refs.length > 0
          ? "buried"
          : "none";
    return {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      count: edge.count,
      confidence: edge.confidence,
      tint: tint === "dead" ? "none" : tint,
      signalIds: refs.map((r) => r.id),
    };
  });
  const journey = stored.journey
    ? journeyView(stored.journey, nodes, kindsById, names, stored.prerequisites)
    : undefined;
  return { nodes, edges, totalTools: stored.totalTools, ...(journey ? { journey } : {}) };
}

/** The open problems a journey node shows as an icon: failing calls and slow calls. */
function flagsOf(kinds: readonly SignalKind[]): FlowJourneyFlag[] {
  const flags: FlowJourneyFlag[] = [];
  if (kinds.includes("error_loop")) flags.push("errors");
  if (kinds.includes("latency_outlier")) flags.push("slow");
  return flags;
}

function isStoredJourney(value: unknown): value is StoredJourney {
  const j = value as StoredJourney | null;
  return !!j && typeof j === "object" && Array.isArray(j.paths) && typeof j.turns === "number";
}

/**
 * The journey with names and tints: a tool drawn on the map takes its node's
 * tint and signals, so muting a signal repaints the journey too; a tool the map
 * folded has neither. Malformed paths are skipped rather than failing the page.
 */
function prerequisitesView(stored: StoredPrerequisites | undefined): FlowPrerequisites | undefined {
  if (
    !stored ||
    typeof stored !== "object" ||
    !Array.isArray(stored.pairs) ||
    typeof stored.windowMs !== "number"
  )
    return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const pairs = stored.pairs
    .filter((p) => !!p && typeof p.a === "string" && typeof p.b === "string" && num(p.n) > 0)
    .map((p) => ({
      first: p.a,
      tool: p.b,
      uses: num(p.n),
      window: num(p.w),
      turn: num(p.t),
      windowLift: num(p.lw),
      turnLift: num(p.lt),
    }));
  return { windowMs: stored.windowMs, pairs };
}

function journeyView(
  stored: StoredJourney,
  nodes: readonly FlowNode[],
  kindsById: ReadonlyMap<string, readonly SignalKind[]>,
  names: ReadonlyMap<string, string>,
  storedPrerequisites?: StoredPrerequisites,
): FlowJourney | undefined {
  if (!isStoredJourney(stored)) return undefined;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const steps = Math.max(1, Math.floor(stored.steps) || 1);
  const paths = stored.paths
    .filter((p) => !!p && Array.isArray(p.t) && typeof p.n === "number" && p.n > 0)
    .map((p) => ({
      start:
        p.s === "search"
          ? ("search" as const)
          : p.s === "agent"
            ? ("agent" as const)
            : ("none" as const),
      tools: p.t
        .slice(0, steps)
        .map((id) => (id === JOURNEY_OTHER_ID ? FLOW_JOURNEY_OTHER : String(id))),
      end: p.e === "more" ? ("more" as const) : ("ended" as const),
      turns: p.n,
    }));
  const prerequisites = prerequisitesView(storedPrerequisites);
  // A pair's tools may never have been named on a path (folded, or past the recorded calls): they get names too.
  const ids = [
    ...new Set([
      ...paths.flatMap((p) => p.tools),
      ...(prerequisites?.pairs.flatMap((p) => [p.first, p.tool]) ?? []),
    ]),
  ].sort();
  const tools = ids.map((id): FlowJourneyTool => {
    if (id === FLOW_JOURNEY_OTHER) {
      return { id, kind: "other", label: "Other tools", tint: "none", signalIds: [], flags: [] };
    }
    const node = byId.get(id);
    const skill = id.startsWith("skill:");
    const entryId = skill ? id.slice("skill:".length) : id;
    return {
      id,
      kind: skill ? "skill" : "tool",
      label: node?.label ?? names.get(entryId) ?? entryId,
      tint: node && node.tint !== "dead" ? node.tint : "none",
      signalIds: node?.signalIds ?? [],
      flags: flagsOf(kindsById.get(id) ?? []),
    };
  });
  return {
    steps,
    turns: paths.reduce((sum, p) => sum + p.turns, 0),
    paths,
    tools,
    otherTools: Array.isArray(stored.other)
      ? stored.other.map((n) => (typeof n === "number" ? n : 0))
      : [],
    searchSignalIds: byId.get("search")?.signalIds ?? [],
    ...(prerequisites ? { prerequisites } : {}),
  };
}
