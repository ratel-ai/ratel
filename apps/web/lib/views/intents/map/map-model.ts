/**
 * The intent map's model: ask groups, the tools and skills that answered them,
 * and the links between the two, in plain terms. Built on the server from the
 * stored projection and handed to the map, the flow and the asks table, which
 * all read this one shape and nothing else (`components/intent-map` never sees
 * a database row).
 *
 * Privacy: nothing here carries member text. A group's label is its own
 * shortest member, which the v1 page already shows; the example asks are read
 * one group at a time when its panel opens.
 */

import type {
  CapabilityInfo,
  IntentGraphClusterSummaryRow,
} from "@/lib/readings/intent-graph/queries";
import type { IntentGraphEdgeRow } from "@/lib/readings/intent-graph/schema";
import type { IntentGraphEdgeKind } from "@/lib/readings/intent-types/wire";
import { askGroupLabel } from "@/lib/views/intents/map/labels";

/** The most groups the map draws; the busiest win and the rest are counted. */
export const MAX_MAP_ASKS = 60;
/** Below this many measured searches a group's first-result rate is not judged. */
export const FIRST_TRY_MIN_SEARCHES = 10;
/** A group whose first result was the tool used less often than this is worth a look. */
export const FIRST_TRY_PROBLEM_RATE = 0.5;

/** Why a group wears the warning mark; null when nothing is wrong. */
export type MapProblem =
  | { kind: "missing"; capability: string }
  | { kind: "first-try"; rate: number }
  /** A topic whose turns mostly went unanswered; `rate` is the unanswered share. */
  | { kind: "unanswered"; rate: number };

/** A task's color on the map (`lib/tasks/palette.ts`): a group's main task tints its blob, a tool's tints its mark. */
export type MapTint = "chart-1" | "chart-5" | "chart-4";

export interface MapAsk {
  /**
   * Stable identity for selection and the URL. The label is raw user text, so
   * this is what names a group wherever a name lands in an attribute (an
   * accessible name, an id), which reaches autocapture and replays.
   */
  id: string;
  label: string;
  /** Asks seen in this group: confirmed ask and tool-call pairs. */
  volume: number;
  /** Distinct phrasings kept for the group. */
  phrasings: number;
  /** Per search, how often the first result was the tool the agent ran, when measured. */
  firstTry: { rate: number; searches: number } | null;
  /** Searches whose list a Cloud graph ranked: left out of `firstTry`. */
  rankedByGraph: number;
  problem: MapProblem | null;
  /** Its main task's color, as a subtle tint; absent or null stays neutral. */
  tint?: MapTint | null;
}

export interface MapCapability {
  /** `tool:<id>` or `skill:<id>`. */
  id: string;
  kind: IntentGraphEdgeKind;
  /** The capability's own id, which is what people know a tool by. */
  name: string;
  /** Calls credited across the drawn groups. */
  calls: number;
  /** How many drawn groups it answers. */
  asks: number;
  /** The catalog no longer lists it, so the agent cannot call it. */
  missing: boolean;
  /** Its main task's color; absent or null stays neutral. */
  tint?: MapTint | null;
  /** Its main task (the task whose runs called it most); absent or null when it has none. */
  task?: string | null;
}

/**
 * A task the drawn tools belong to (`lib/tasks`): what the agent does for an
 * ask, the tools it runs in order. The Tools lens gives each one a home.
 */
export interface MapTask {
  id: string;
  /** Model-written from tool ids, or the tools themselves: text only, never an attribute. */
  name: string;
  /** Its color when it is one of the three busiest tasks; null stays neutral. */
  slot: MapTint | null;
  runs: number;
  /** Capability keys of the tools in its steps, in order; empty when the steps were not read. */
  steps: string[];
}

export interface MapLink {
  ask: string;
  capability: string;
  weight: number;
  /** This capability's share of the group's calls, 0..1. */
  share: number;
}

export interface IntentMapModel {
  asks: MapAsk[];
  capabilities: MapCapability[];
  links: MapLink[];
  /** Groups left off because the map was full, with the asks they hold. */
  hidden: { asks: number; volume: number } | null;
  /** The tasks its tools belong to, busiest first; absent when tasks are not known (Adaptive ranking's graphs). */
  tasks?: MapTask[];
}

/**
 * What the drawing's positions depend on: the groups with their volumes, the
 * capabilities, and the links between them. A new copy of the same model, a
 * renamed group or a changed problem keeps the drawing, and the reader's pan
 * and zoom; a change here lays it out again.
 */
export function mapLayoutKey(model: IntentMapModel): string {
  return JSON.stringify([
    model.asks.map((ask) => [ask.id, ask.volume]),
    model.capabilities.map((capability) => capability.id),
    model.links.map((link) => [link.ask, link.capability, link.weight]),
  ]);
}

export interface AskOutcome {
  clusterId: string;
  /** Searches with a served list and a tool the agent ran, scored. */
  ranked: number;
  /** Of those, how many had that search's own tool first. */
  firstTry: number;
  /** Searches whose list a Cloud graph ranked: not scored, counted apart. */
  shaped: number;
}

export function capabilityKey(kind: IntentGraphEdgeKind, id: string): string {
  return `${kind}:${id}`;
}

export function splitCapabilityKey(key: string): { kind: IntentGraphEdgeKind; id: string } | null {
  const index = key.indexOf(":");
  if (index <= 0) return null;
  const kind = key.slice(0, index);
  if (kind !== "tool" && kind !== "skill") return null;
  return { kind, id: key.slice(index + 1) };
}

function byVolume(a: IntentGraphClusterSummaryRow, b: IntentGraphClusterSummaryRow): number {
  return (
    b.support - a.support ||
    b.memberCount - a.memberCount ||
    (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0)
  );
}

export function buildIntentMapModel(input: {
  clusters: readonly IntentGraphClusterSummaryRow[];
  edges: readonly IntentGraphEdgeRow[];
  /** `kind:id` of capabilities the catalog no longer lists. */
  missing?: ReadonlySet<string>;
  outcomes?: readonly AskOutcome[];
  maxAsks?: number;
}): IntentMapModel {
  const missing = input.missing ?? new Set<string>();
  const maxAsks = input.maxAsks ?? MAX_MAP_ASKS;
  const ranked = [...input.clusters].sort(byVolume);
  const drawn = ranked.slice(0, maxAsks);
  const rest = ranked.slice(maxAsks);
  const drawnIds = new Set(drawn.map((cluster) => cluster.clusterId));
  const outcomes = new Map((input.outcomes ?? []).map((outcome) => [outcome.clusterId, outcome]));

  const edgesByAsk = new Map<string, IntentGraphEdgeRow[]>();
  for (const edge of input.edges) {
    if (!drawnIds.has(edge.clusterId) || !(edge.weight > 0)) continue;
    const list = edgesByAsk.get(edge.clusterId);
    if (list) list.push(edge);
    else edgesByAsk.set(edge.clusterId, [edge]);
  }

  const capabilities = new Map<string, MapCapability>();
  const links: MapLink[] = [];
  const asks: MapAsk[] = drawn.map((cluster) => {
    const own = (edgesByAsk.get(cluster.clusterId) ?? []).sort(
      (a, b) => b.weight - a.weight || (a.capabilityId < b.capabilityId ? -1 : 1),
    );
    const total = own.reduce((sum, edge) => sum + edge.weight, 0);
    for (const edge of own) {
      const key = capabilityKey(edge.kind, edge.capabilityId);
      const capability = capabilities.get(key) ?? {
        id: key,
        kind: edge.kind,
        name: edge.capabilityId,
        calls: 0,
        asks: 0,
        missing: missing.has(key),
      };
      capability.calls += edge.weight;
      capability.asks += 1;
      capabilities.set(key, capability);
      links.push({
        ask: cluster.clusterId,
        capability: key,
        weight: edge.weight,
        share: total > 0 ? edge.weight / total : 0,
      });
    }
    const outcome = outcomes.get(cluster.clusterId);
    const firstTry =
      outcome && outcome.ranked > 0
        ? { rate: outcome.firstTry / outcome.ranked, searches: outcome.ranked }
        : null;
    const top = own[0];
    const topKey = top ? capabilityKey(top.kind, top.capabilityId) : null;
    const problem: MapProblem | null =
      topKey !== null && missing.has(topKey)
        ? { kind: "missing", capability: top!.capabilityId }
        : firstTry &&
            firstTry.searches >= FIRST_TRY_MIN_SEARCHES &&
            firstTry.rate < FIRST_TRY_PROBLEM_RATE
          ? { kind: "first-try", rate: firstTry.rate }
          : null;
    return {
      id: cluster.clusterId,
      label: askGroupLabel({
        label: cluster.label,
        labelOverride: cluster.labelOverride,
        terms: cluster.terms,
      }),
      volume: cluster.support,
      phrasings: cluster.memberCount,
      firstTry,
      rankedByGraph: outcome?.shaped ?? 0,
      problem,
    };
  });

  return {
    asks,
    capabilities: [...capabilities.values()].sort(
      (a, b) => b.calls - a.calls || a.id.localeCompare(b.id),
    ),
    links,
    hidden:
      rest.length > 0
        ? { asks: rest.length, volume: rest.reduce((sum, cluster) => sum + cluster.support, 0) }
        : null,
  };
}

/**
 * An intent's accessible name on the map: its id and its numbers, never its
 * label. The label comes from people's asks, and accessible names are
 * attributes, which reach autocapture and session replay where visible text
 * does not.
 */
export function askGroupName(
  ask: Pick<MapAsk, "id" | "volume" | "problem">,
  tools: number,
): string {
  const problem = ask.problem
    ? ask.problem.kind === "unanswered"
      ? ", mostly unanswered"
      : ", needs a look"
    : "";
  const asks = `${ask.volume.toLocaleString("en-US")} ${ask.volume === 1 ? "ask" : "asks"}`;
  return `Intent ${ask.id}: ${asks}, ${tools} ${tools === 1 ? "tool" : "tools"}${problem}`;
}

/** What a problem means, in one sentence. */
export function problemSentence(problem: MapProblem): string {
  if (problem.kind === "missing")
    return `Its main tool, ${problem.capability}, is no longer in your catalog, so the agent cannot call it.`;
  if (problem.kind === "unanswered")
    return `${Math.round(problem.rate * 100)}% of its turns went unanswered.`;
  return `The first result was the tool the agent ran only ${Math.round(problem.rate * 100)}% of the time.`;
}

/** The short word a problem shows as, beside its mark. */
export function problemWord(problem: MapProblem): string {
  return problem.kind === "unanswered" ? "Mostly unanswered" : "Needs a look";
}

/** What the per-search first-result rates were read over. */
export interface FirstTryReading {
  /** Searches in the window that ran a tool, as read. */
  searches: number;
  /** True when the window held more of them than were read. */
  capped: boolean;
  windowDays: number;
}

/** The rule behind "Needs a look", in plain words, for the map and the panel. */
export function problemRule(reading: FirstTryReading): string {
  const scope = reading.capped
    ? `the latest ${reading.searches.toLocaleString("en-US")} searches of the last ${reading.windowDays} days`
    : `the last ${reading.windowDays} days`;
  return (
    `A group needs a look when its main tool left your catalog, or when, over ${FIRST_TRY_MIN_SEARCHES} or more of its searches in ${scope}, ` +
    `the first result was the tool the agent ran under ${Math.round(FIRST_TRY_PROBLEM_RATE * 100)}% of the time. ` +
    "Searches whose list a Cloud graph ranked are not counted."
  );
}

/** What one group's rate is read over, in a sentence. */
export function firstTrySentence(
  ask: Pick<MapAsk, "firstTry" | "rankedByGraph">,
  reading: FirstTryReading,
): string {
  const days = `the last ${reading.windowDays} days`;
  const left =
    ask.rankedByGraph > 0
      ? ` ${ask.rankedByGraph.toLocaleString("en-US")} more ${ask.rankedByGraph === 1 ? "was" : "were"} ranked by a Cloud graph and ${ask.rankedByGraph === 1 ? "is" : "are"} not counted.`
      : "";
  if (!ask.firstTry)
    return `Not measured: none of its searches in ${days} showed a list and then ran a tool.${left}`;
  const searches = ask.firstTry.searches;
  return `Of its ${searches.toLocaleString("en-US")} ${searches === 1 ? "search" : "searches"} in ${days} that showed a list and then ran a tool, the first result was that tool ${Math.round(ask.firstTry.rate * 100)}% of the time.${left}`;
}

// --- the asks table ------------------------------------------------------------

export interface AskRow {
  id: string;
  label: string;
  volume: number;
  /** Share of every ask on the graph, 0..1. */
  share: number;
  /** The tools and skills that answered, busiest first, with their share of the group. */
  answers: Array<{
    id: string;
    kind: IntentGraphEdgeKind;
    name: string;
    share: number;
    missing: boolean;
  }>;
  firstTry: MapAsk["firstTry"];
  problem: MapProblem | null;
}

export type AskSort = "volume" | "first-try" | "label";

export function buildAskRows(model: IntentMapModel, sort: AskSort = "volume"): AskRow[] {
  const total = model.asks.reduce((sum, ask) => sum + ask.volume, 0) + (model.hidden?.volume ?? 0);
  const capabilityById = new Map(
    model.capabilities.map((capability) => [capability.id, capability]),
  );
  const linksByAsk = new Map<string, MapLink[]>();
  for (const link of model.links)
    linksByAsk.set(link.ask, [...(linksByAsk.get(link.ask) ?? []), link]);
  const rows = model.asks.map(
    (ask): AskRow => ({
      id: ask.id,
      label: ask.label,
      volume: ask.volume,
      share: total > 0 ? ask.volume / total : 0,
      answers: (linksByAsk.get(ask.id) ?? [])
        .sort((a, b) => b.share - a.share)
        .map((link) => {
          const capability = capabilityById.get(link.capability)!;
          return {
            id: capability.id,
            kind: capability.kind,
            name: capability.name,
            share: link.share,
            missing: capability.missing,
          };
        }),
      firstTry: ask.firstTry,
      problem: ask.problem,
    }),
  );
  if (sort === "label") return rows.sort((a, b) => a.label.localeCompare(b.label));
  if (sort === "first-try") {
    // Measured groups first, worst first, so the ones to look at lead.
    return rows.sort(
      (a, b) => (a.firstTry?.rate ?? 2) - (b.firstTry?.rate ?? 2) || b.volume - a.volume,
    );
  }
  return rows;
}

export function parseAskSort(raw: string | null | undefined): AskSort {
  return raw === "first-try" || raw === "label" ? raw : "volume";
}

// --- the header figures --------------------------------------------------------

export interface IntentFigures {
  askGroups: number;
  asksSeen: number;
  tools: number;
  skills: number;
}

export function intentFigures(
  clusters: readonly Pick<IntentGraphClusterSummaryRow, "support">[],
  edges: readonly Pick<IntentGraphEdgeRow, "kind" | "capabilityId" | "weight">[],
): IntentFigures {
  const tools = new Set<string>();
  const skills = new Set<string>();
  for (const edge of edges) {
    if (!(edge.weight > 0)) continue;
    (edge.kind === "tool" ? tools : skills).add(edge.capabilityId);
  }
  return {
    askGroups: clusters.length,
    asksSeen: clusters.reduce((sum, cluster) => sum + cluster.support, 0),
    tools: tools.size,
    skills: skills.size,
  };
}

/** Abbreviated for a stat ("12.4K"); exact below a thousand. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1_000) return Math.round(value).toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** One capability's entry in a tool panel: the groups it answers, busiest first. */
export function capabilityAsks(
  model: IntentMapModel,
  capabilityId: string,
): Array<{ ask: MapAsk; weight: number; share: number }> {
  const asks = new Map(model.asks.map((ask) => [ask.id, ask]));
  return model.links
    .filter((link) => link.capability === capabilityId)
    .map((link) => ({ ask: asks.get(link.ask)!, weight: link.weight, share: link.share }))
    .filter((entry) => entry.ask !== undefined)
    .sort((a, b) => b.weight - a.weight || a.ask.label.localeCompare(b.ask.label));
}

/** Catalog details for a capability key, when the catalog knows it. */
export function capabilityDetails(
  capabilities: Readonly<Record<string, CapabilityInfo>>,
  key: string,
): CapabilityInfo | null {
  return capabilities[key] ?? null;
}
