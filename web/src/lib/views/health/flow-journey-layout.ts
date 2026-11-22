import type {
  FlowJourney,
  FlowJourneyFlag,
  FlowJourneyPath,
  FlowTint,
} from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";
import { round } from "@/lib/views/health/flow-route";

/**
 * The journey map's layout: a step-by-step Sankey of how turns unfold, drawn
 * as lanes of chips with ribbons in the gaps between them.
 *
 * Columns are positions in a turn, left to right: how it started (searched
 * first or not), its 1st, 2nd, 3rd... call, up to the last position any turn
 * reached (at most {@link JOURNEY_MAX_CALLS}; an empty position never draws),
 * and "Then" (more calls, or ended). At rest only the first
 * {@link JOURNEY_VISIBLE_CALLS} calls are drawn and everything after folds
 * into one compact "Later calls" column, so the map fits its card; the reader
 * unfolds later calls one column at a time (`depth`).
 * Each column is a fixed-width lane of chips; a chip holds its icon, name and
 * count, and every chip in a lane has the same width and height. Ribbons leave
 * a chip's right edge and reach the next lane's left edge, so they only ever
 * run through the gap between two lanes and no ribbon crosses any text.
 *
 * A tool appears in every column it was called in, and a repeat is a ribbon
 * from a tool to itself one column over. Every ribbon ends somewhere: a turn
 * that stops flows into the next column's grey "Ended" chip.
 *
 * Volume is carried twice: by ribbon thickness (one scale for the whole map),
 * and by a thin bar inside each chip showing its share of all turns. Every
 * chip is one height. The scale is set so the busiest tool's ribbons fit its
 * chip. A start chip busier than that attaches its ribbons flush, compressed
 * to fit the chip, and they widen to full thickness along their one swing
 * through the first gap, which is the widest because it carries the fan-out.
 * Anywhere else a crowded edge (a big "Ended" chip's inflow) keeps its
 * ribbons fitted along their whole length.
 *
 * Ribbons stay calm: every chip's ribbons are stacked in the order of where
 * they go (or come from), so none of them cross; each runs level out of its
 * chip, swings in the middle of the gap with level tangents, and runs level
 * into the next chip. The start and "Then" chips sit at the centre of what
 * they reach, so their fans spread up and down rather than dive.
 *
 * Only the busiest tools of a column are named; the rest fold into one "+N
 * tools" chip. Ribbons take the colour of the path's first tool (four busiest
 * first tools; the rest grey).
 *
 * Pure and deterministic: the same journey lays out the same way on the server
 * and in the browser. Every coordinate is rounded to a tenth.
 */

/** Call columns drawn at most; a longer journey folds into "More calls". Matches the run's `JOURNEY_STEPS`. */
export const JOURNEY_MAX_CALLS = 8;
/** Call columns that fit the card before the map scrolls. */
export const JOURNEY_VISIBLE_CALLS = 3;
/** First tools that get their own colour; the rest are grey. */
export const JOURNEY_FAMILIES = 8;
/** Tools named in a call column at first; the rest fold into one "+N tools" chip. */
export const JOURNEY_SHOWN_TOOLS = 7;
/** A link is drawn by default only when it carries at least this many turns... */
export const JOURNEY_LINK_MIN_TURNS = 3;
/** ...and at least this share of the turns leaving its source chip. */
export const JOURNEY_LINK_MIN_SHARE = 0.05;
/** Tools a click on "+N tools" reveals. */
export const JOURNEY_EXPAND_STEP = 3;
export const JOURNEY_FONT = 11;
/** The family of the grey ribbons into an "Ended" chip. */
export const JOURNEY_ENDED_FAMILY = -2;

const G = {
  padX: 12,
  /** Room above the lanes for the column titles. */
  padTop: 30,
  padBottom: 4,
  startWidth: 132,
  thenWidth: 118,
  laterWidth: 118,
  callWidth: 176,
  /** The first gap, where the start chips fan out, is the widest. */
  startGap: 116,
  gap: 55,
  /** Every ribbon runs level at least this far, and this share of its gap, out of and into a chip. */
  flatRun: 12,
  levelShare: 0.2,
  chipH: 38,
  chipGap: 8,
  /** Extra space above a column's "Ended" chip. */
  endedGap: 10,
  /** Ribbon ends stay this far inside a chip's top and bottom. */
  bandInset: 6,
  minBand: 1,
  /** The thinnest a compressed ribbon gets where it meets its chip. */
  minPort: 1,
  /** Text inset: icon at `padL`, name at `textX`. */
  padL: 10,
  textX: 26,
  padR: 10,
  charWidth: JOURNEY_FONT * 0.6,
} as const;

/** The grid a compacted map (`flow-journey-compact`) packs its chips on: the same as the full map's. */
export const JOURNEY_GRID = {
  padX: G.padX,
  padTop: G.padTop,
  padBottom: G.padBottom,
  chipH: G.chipH,
  chipGap: G.chipGap,
  gap: G.gap,
  callWidth: G.callWidth,
} as const;
export const JOURNEY_CHIP = {
  height: G.chipH,
  bandInset: G.bandInset,
  flatRun: G.flatRun,
  levelShare: G.levelShare,
  minPort: G.minPort,
  padL: G.padL,
  textX: G.textX,
  padR: G.padR,
} as const;

/** `across`: the prerequisites view's columns of tools linked across turns (`flow-journey-compact`). */
export type JourneyColumnRole = "start" | "call" | "later" | "then" | "across";
export type JourneyNodeKind =
  | "search"
  | "none"
  | "agent"
  | "tool"
  | "skill"
  | "other"
  | "more"
  | "ended"
  | "later";

export interface JourneyColumn {
  index: number;
  role: JourneyColumnRole;
  /** 1 for the 1st call; 0 for the start and "Then" columns. */
  call: number;
  title: string;
  /** The lane: every chip in it has this left edge and width. */
  x: number;
  width: number;
  /** Turns that made this call (start: every turn), "Ended" not included. */
  turns: number;
}

export interface JourneyNode {
  /** `s:search`, `s:none`, `c2:update_task`, `e2` (ended before a 2nd call), `more`. */
  key: string;
  /** The tool id (or `search`, `none`, `more`, `ended`, `~other`). */
  id: string;
  kind: JourneyNodeKind;
  column: number;
  /** 1-based call position; 0 for start and "Then". */
  call: number;
  label: string;
  /** The label as drawn, cut with an ellipsis to fit the chip. */
  text: string;
  tint: FlowTint;
  signalIds: readonly string[];
  /** Open problems shown as icons: failing calls, slow calls. */
  flags: readonly FlowJourneyFlag[];
  /** A 1st-call tool's colour family, or -1. */
  family: number;
  turns: number;
  /** Share of all turns, for the chip's volume bar. */
  share: number;
  /** Of `turns`, how many ended right after this chip (they flow into the next "Ended"). */
  ended: number;
  /** How many tools a "+N tools" chip folds; null elsewhere. */
  otherCount: number | null;
  /** Of those, how many a click can still reveal by name (the rest the run itself folded). */
  expandable: number;
  order: number;
  /** The chip; every chip has the same height. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A ribbon: the turns of one colour family between two chips in adjacent lanes. */
export interface JourneyRibbon {
  key: string;
  from: string;
  to: string;
  family: number;
  turns: number;
  /** Top edge and thickness where the ribbon attaches: flush with each chip's edge, inside its bounds. */
  x0: number;
  y0: number;
  t0: number;
  x1: number;
  y1: number;
  t1: number;
  /**
   * The ribbon's shape, left to right: its attachment, then (at a heavy chip)
   * where it reaches full thickness, and so on to the other attachment.
   */
  stations: readonly RibbonStation[];
  /** Too thin to matter at rest: drawn faint until one of its paths is traced. */
  minor: boolean;
  /** Into or out of a "+N tools" chip: real traffic, but drawn quieter at rest. */
  fold: boolean;
  path: string;
}

/** A point along a ribbon: its top edge and thickness at `x`. */
export interface RibbonStation {
  x: number;
  y: number;
  t: number;
}

/** A path as node keys, start to terminal ("Ended" or "More calls"), for focus. */
export interface JourneyRoute {
  keys: readonly string[];
  family: number;
  turns: number;
}

export interface JourneyFamily {
  index: number;
  id: string;
  label: string;
}

export interface JourneyLayout {
  /** Call positions any turn reached: the columns the map can unfold to. */
  calls: number;
  /** Call columns drawn now; the rest are folded into the "Later calls" column. */
  depth: number;
  /** Tools revealed per call column beyond the first seven (1-based column keys). */
  expanded: Readonly<Record<number, number>>;
  width: number;
  height: number;
  /** Links left out by the default threshold (0 when every link is drawn). */
  hiddenLinks: number;
  /** Pixels per turn for ribbons, before any squeeze at a crowded chip edge. */
  scale: number;
  turns: number;
  columns: readonly JourneyColumn[];
  nodes: readonly JourneyNode[];
  ribbons: readonly JourneyRibbon[];
  /** Direct links between tools called in different turns: only in the packed prerequisites view. */
  links?: readonly JourneyCrossLink[];
  /** Titled rules across the map, above the rows of those links. */
  dividers?: readonly JourneyDivider[];
  routes: readonly JourneyRoute[];
  families: readonly JourneyFamily[];
}

/**
 * A direct link from a tool to one that needs it first, when the two were
 * mostly called in different turns (the prerequisites view draws it dashed).
 * `relationKey` is `first>tool`, as the prerequisite names it.
 */
export interface JourneyCrossLink {
  key: string;
  from: string;
  to: string;
  relationKey: string;
  turns: number;
  width: number;
  /** The two were called in different turns (dashed); otherwise a turn held them but its path was folded away. */
  crossTurn: boolean;
  /** The curve, from the right edge of `from` to the arrowhead. */
  path: string;
  /** The arrowhead, touching the left edge of `to`. */
  head: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A thin rule across the map with a small title, between the packed journey and the rows under it. */
export interface JourneyDivider {
  y: number;
  title: string;
}

/** An axis-aligned box, for label and ribbon bounds. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th"] as const;

export function ordinal(call: number): string {
  return ORDINAL[call - 1] ?? `${call}th`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function truncate(label: string, chars: number): string {
  if (chars < 2) return "";
  return label.length <= chars ? label : `${label.slice(0, chars - 1)}…`;
}

export function countText(turns: number): string {
  return turns.toLocaleString("en-US");
}

export function otherLabel(count: number): string {
  if (count <= 0) return "Other tools";
  return `+${count} ${count === 1 ? "tool" : "tools"}`;
}

/* - Folding for display ------------------------------------------------------ */

function pathKey(path: FlowJourneyPath): string {
  return [path.start, path.end, ...path.tools].join("\u0001");
}

/**
 * Names only the busiest {@link JOURNEY_SHOWN_TOOLS} tools of each call
 * column (more where the reader expanded it); the rest join "other", and
 * paths that become equal merge. A column one tool over keeps it, so "+1
 * tool" never replaces a name.
 */
function foldForDisplay(
  journey: FlowJourney,
  calls: number,
  expanded: Readonly<Record<number, number>>,
): { paths: FlowJourneyPath[]; otherTools: number[]; expandable: number[] } {
  const kept = Array.from({ length: calls }, (_, k) => {
    const counts = new Map<string, number>();
    for (const path of journey.paths) {
      const id = path.tools[k];
      if (id !== undefined && id !== FLOW_JOURNEY_OTHER)
        counts.set(id, (counts.get(id) ?? 0) + path.turns);
    }
    const ranked = [...counts]
      .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
      .map(([id]) => id);
    const shown = JOURNEY_SHOWN_TOOLS + Math.max(0, expanded[k + 1] ?? 0);
    const limit = ranked.length <= shown + 1 ? ranked.length : shown;
    return { names: new Set(ranked.slice(0, limit)), dropped: Math.max(0, ranked.length - limit) };
  });
  const merged = new Map<string, FlowJourneyPath>();
  for (const path of journey.paths) {
    const tools = path.tools.map((id, k) =>
      k < calls && !kept[k].names.has(id) ? FLOW_JOURNEY_OTHER : id,
    );
    const next = { ...path, tools };
    const key = pathKey(next);
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, turns: prior.turns + path.turns } : next);
  }
  return {
    paths: [...merged.values()],
    otherTools: kept.map((k, i) => (journey.otherTools[i] ?? 0) + k.dropped),
    expandable: kept.map((k) => k.dropped),
  };
}

/* - Nodes --------------------------------------------------------------------- */

/**
 * The node keys a path passes through, ending at "Ended", "More calls", or,
 * past the columns drawn now (`depth`), the folded "Later calls" column.
 */
function routeKeys(path: FlowJourneyPath, calls: number, depth: number): string[] {
  const tools = path.tools.slice(0, depth);
  const keys = [`s:${path.start}`, ...tools.map((id, i) => `c${i + 1}:${id}`)];
  if (depth < calls && path.tools.length > depth) return [...keys, JOURNEY_LATER_KEY];
  const more = path.end === "more" || path.tools.length > calls;
  if (more && tools.length === calls) return [...keys, "more"];
  return [...keys, `e${tools.length + 1}`];
}

/** The folded "Later calls" chip's key. */
export const JOURNEY_LATER_KEY = "later";

/** The last call position any turn reached; later positions are empty and never draw. */
export function lastCallReached(journey: FlowJourney): number {
  return Math.min(
    JOURNEY_MAX_CALLS,
    journey.steps,
    Math.max(0, ...journey.paths.filter((p) => p.turns > 0).map((p) => p.tools.length)),
  );
}

function isEndedKey(key: string): boolean {
  return /^e\d+$/.test(key);
}

function familiesOf(journey: FlowJourney, labels: ReadonlyMap<string, string>): JourneyFamily[] {
  const first = new Map<string, number>();
  for (const path of journey.paths) {
    const id = path.tools[0];
    if (id !== undefined && id !== FLOW_JOURNEY_OTHER)
      first.set(id, (first.get(id) ?? 0) + path.turns);
  }
  return [...first]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, JOURNEY_FAMILIES)
    .map(([id], index) => ({ index, id, label: labels.get(id) ?? id }));
}

type Draft = Omit<JourneyNode, "order" | "x" | "y" | "w" | "h" | "text" | "share">;

interface DraftContext {
  journey: FlowJourney;
  calls: number;
  depth: number;
  otherTools: readonly number[];
  expandable: readonly number[];
  families: ReadonlyMap<string, number>;
}

/** The start column's words: OpenTelemetry turns start at the agent, with no search step to miss. */
const START_LABEL: Readonly<Record<"search" | "none" | "agent", string>> = {
  search: "Searched first",
  none: "No search",
  agent: "Agent",
};

function draftNode(key: string, turns: number, ended: number, ctx: DraftContext): Draft {
  const base = {
    key,
    turns,
    ended,
    tint: "none" as FlowTint,
    signalIds: [] as readonly string[],
    flags: [] as readonly FlowJourneyFlag[],
    otherCount: null,
    expandable: 0,
    family: -1,
  };
  if (key === "more")
    return {
      ...base,
      id: "more",
      kind: "more",
      column: ctx.calls + 1,
      call: 0,
      label: "More calls",
    };
  if (key === JOURNEY_LATER_KEY) {
    const first = ctx.depth + 1;
    const label =
      first === ctx.calls ? `${ordinal(first)} call` : `${ordinal(first)} to ${ordinal(ctx.calls)}`;
    return { ...base, id: JOURNEY_LATER_KEY, kind: "later", column: first, call: first, label };
  }
  if (isEndedKey(key))
    return {
      ...base,
      id: "ended",
      kind: "ended",
      column: Number(key.slice(1)),
      call: 0,
      label: "Ended",
    };
  if (key.startsWith("s:")) {
    const start = key === "s:search" ? "search" : key === "s:agent" ? "agent" : "none";
    return {
      ...base,
      id: start,
      kind: start,
      column: 0,
      call: 0,
      label: START_LABEL[start],
      signalIds: start === "search" ? ctx.journey.searchSignalIds : [],
    };
  }
  const call = Number(key.slice(1, key.indexOf(":")));
  const id = key.slice(key.indexOf(":") + 1);
  const tool = ctx.journey.tools.find((t) => t.id === id);
  const other = id === FLOW_JOURNEY_OTHER;
  const otherCount = other ? (ctx.otherTools[call - 1] ?? 0) : null;
  return {
    ...base,
    id,
    kind: other ? "other" : tool?.kind === "skill" ? "skill" : "tool",
    column: call,
    call,
    label: other ? otherLabel(otherCount ?? 0) : (tool?.label ?? id),
    tint: tool?.tint ?? "none",
    signalIds: tool?.signalIds ?? [],
    flags: tool?.flags ?? [],
    family: call === 1 ? (ctx.families.get(id) ?? -1) : -1,
    otherCount,
    expandable: other ? (ctx.expandable[call - 1] ?? 0) : 0,
  };
}

function draftNodes(routes: readonly JourneyRoute[], ctx: DraftContext): Draft[] {
  const turns = new Map<string, number>();
  const ended = new Map<string, number>();
  for (const route of routes) {
    for (const key of route.keys) turns.set(key, (turns.get(key) ?? 0) + route.turns);
    const last = route.keys[route.keys.length - 1];
    if (isEndedKey(last)) {
      const before = route.keys[route.keys.length - 2];
      ended.set(before, (ended.get(before) ?? 0) + route.turns);
    }
  }
  return [...turns].map(([key, count]) => draftNode(key, count, ended.get(key) ?? 0, ctx));
}

const KIND_LAST: Partial<Record<JourneyNodeKind, number>> = { other: 1, more: 0, ended: 2 };

/** Start: searched above no search. Otherwise most turns first; "+N tools", then "Ended" last. */
function nodeOrder(a: Draft, b: Draft): number {
  if (a.column === 0) return a.kind === "search" ? -1 : b.kind === "search" ? 1 : 0;
  return (
    (KIND_LAST[a.kind] ?? 0) - (KIND_LAST[b.kind] ?? 0) ||
    b.turns - a.turns ||
    compareText(a.id, b.id)
  );
}

function columnTitle(role: JourneyColumnRole, call: number): string {
  if (role === "start") return "Start";
  if (role === "then") return "Then";
  if (role === "later") return "Later";
  return `${ordinal(call)} call`;
}

export interface JourneyLayoutOptions {
  /** Tools revealed per call column (1-based) beyond the first seven, in steps of {@link JOURNEY_EXPAND_STEP}. */
  expanded?: Readonly<Record<number, number>>;
  /** Call columns to draw; later calls fold into "Later calls". Defaults to {@link JOURNEY_VISIBLE_CALLS}. */
  depth?: number;
  /** Draw every link. By default a link is drawn only when it carries {@link JOURNEY_LINK_MIN_TURNS} turns and {@link JOURNEY_LINK_MIN_SHARE} of its source's turns. */
  showAll?: boolean;
}

/** The characters of a label that fit on a chip's first line (flags sit on the second). */
/** A name cut to fit a chip of this width. */
export function chipText(label: string, width: number): string {
  return truncate(label, labelRoom(width));
}

function labelRoom(width: number): number {
  return Math.floor((width - G.textX - G.padR) / G.charWidth);
}

/* - Ribbons ------------------------------------------------------------------- */

/**
 * A filled band through its stations. Each stretch is a cubic, level at both
 * ends, for its top and its bottom edge alike, so both edges ease the same way
 * and the thickness changes monotonically between two stations: no bulges.
 */
function bandPath(stations: readonly RibbonStation[]): string {
  const f = (v: number) => String(round(v));
  const top = stations
    .slice(1)
    .map((s, i) => {
      const prev = stations[i];
      const mid = (prev.x + s.x) / 2;
      return ` C${f(mid)} ${f(prev.y)} ${f(mid)} ${f(s.y)} ${f(s.x)} ${f(s.y)}`;
    })
    .join("");
  const back = [...stations].reverse();
  const bottom = back
    .slice(1)
    .map((s, i) => {
      const prev = back[i];
      const mid = (prev.x + s.x) / 2;
      return ` C${f(mid)} ${f(prev.y + prev.t)} ${f(mid)} ${f(s.y + s.t)} ${f(s.x)} ${f(s.y + s.t)}`;
    })
    .join("");
  const first = stations[0];
  const last = back[0];
  return `M${f(first.x)} ${f(first.y)}${top} L${f(last.x)} ${f(last.y + last.t)}${bottom} Z`;
}

/** The band for a ribbon, or its top `share` (focus), never thinner than `min`. */
export function ribbonBand(ribbon: JourneyRibbon, share = 1, min: number = G.minBand): string {
  return bandPath(ribbon.stations.map((s) => ({ ...s, t: Math.max(min, s.t * share) })));
}

/**
 * A ribbon's bounds. Its curves' control points sit level with its stations,
 * so the band never leaves the box its stations span.
 */
export function ribbonBox(ribbon: JourneyRibbon): Box {
  const top = Math.min(...ribbon.stations.map((s) => s.y));
  const bottom = Math.max(...ribbon.stations.map((s) => s.y + s.t));
  return { x: ribbon.x0, y: top, w: ribbon.x1 - ribbon.x0, h: bottom - top };
}

function familyOrder(a: number, b: number): number {
  const rank = (f: number) => (f === JOURNEY_ENDED_FAMILY ? 100 : f < 0 ? 99 : f);
  return rank(a) - rank(b);
}

interface Segment {
  key: string;
  from: string;
  to: string;
  family: number;
  turns: number;
}

/**
 * A ribbon's colour family by where it runs. Into a terminal the colour has
 * nothing left to follow: into "Ended" it is the grey fade, into "More calls"
 * or the folded "Later" plain grey. In and out of a "+N tools" chip, itself a fold of many tools,
 * it is plain grey too. In each case one ribbon joins two chips rather than
 * one per family, so the few heavy chips never collect dozens of hairlines.
 */
export function familyInto(from: string, to: string, family: number): number {
  if (isEndedKey(to)) return JOURNEY_ENDED_FAMILY;
  if (to === "more" || to === JOURNEY_LATER_KEY || isOtherKey(from) || isOtherKey(to)) return -1;
  return family;
}

function isOtherKey(key: string): boolean {
  return key.endsWith(`:${FLOW_JOURNEY_OTHER}`);
}

function segmentsOf(routes: readonly JourneyRoute[]): Segment[] {
  const segments = new Map<string, Segment>();
  for (const route of routes) {
    for (let i = 0; i + 1 < route.keys.length; i += 1) {
      const from = route.keys[i];
      const to = route.keys[i + 1];
      const family = familyInto(from, to, route.family);
      const key = `${from}>${to}#${family}`;
      const prior = segments.get(key);
      segments.set(key, { key, from, to, family, turns: (prior?.turns ?? 0) + route.turns });
    }
  }
  return [...segments.values()];
}

function rawThickness(turns: number, scale: number): number {
  return Math.max(G.minBand, turns * scale);
}

/**
 * Thicknesses for a bundle squeezed into `room`: every ribbon scaled by one
 * factor, none thinner than {@link G.minPort} (or an even share of the room
 * when there are too many ribbons for that).
 */
function fitToRoom(raw: readonly number[], room: number): number[] {
  const floor = Math.min(G.minPort, room / raw.length);
  const total = (factor: number) => raw.reduce((sum, t) => sum + Math.max(floor, t * factor), 0);
  if (total(1) <= room) return [...raw];
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (total(mid) <= room) low = mid;
    else high = mid;
  }
  return raw.map((t) => Math.max(floor, t * low));
}

function groupBy(list: readonly Segment[], end: "from" | "to"): Map<string, Segment[]> {
  const groups = new Map<string, Segment[]>();
  for (const segment of list)
    groups.set(segment[end], [...(groups.get(segment[end]) ?? []), segment]);
  return groups;
}

interface Sizes {
  /** Each ribbon's thickness along its length (and at every edge but a start chip's). */
  t: Map<string, number>;
  /** At a start chip's crowded out edge: each ribbon's thickness where it attaches. */
  port: Map<string, number>;
}

/**
 * Ribbon thicknesses. One scale for the map; an edge whose bundle would
 * overflow its chip is fitted to it. At a start chip that fitting happens only
 * where the ribbons attach, and they widen to full thickness early in the
 * wide first gap (the fan-out). Anywhere else (a big "Ended" chip's inflow,
 * say) the fitted thickness holds for the ribbon's whole length: those gaps
 * are narrow, and widening inside them would flare at the edge.
 */
function sizeRibbons(
  list: readonly Segment[],
  scale: number,
  isStart: (key: string) => boolean,
): Sizes {
  const inner = G.chipH - 2 * G.bandInset;
  const raw = new Map(list.map((s) => [s.key, rawThickness(s.turns, scale)]));
  const t = new Map(raw);
  for (const end of ["from", "to"] as const) {
    for (const [owner, segments] of groupBy(list, end)) {
      if (end === "from" && isStart(owner)) continue;
      const fitted = fitToRoom(
        segments.map((s) => raw.get(s.key)!),
        inner,
      );
      segments.forEach((s, i) => t.set(s.key, Math.min(t.get(s.key)!, fitted[i])));
    }
  }
  const port = new Map<string, number>();
  for (const [owner, segments] of groupBy(list, "from")) {
    if (!isStart(owner)) continue;
    const fitted = fitToRoom(
      segments.map((s) => t.get(s.key)!),
      inner,
    );
    segments.forEach((s, i) => port.set(s.key, fitted[i]));
  }
  return { t, port };
}

interface EdgeStack {
  /** Where the ribbon attaches, inside the chip. */
  port: { y: number; t: number };
  /** Its full thickness, in a bundle centred on the chip; the same as `port` except at a crowded start chip. */
  full: { y: number; t: number };
}

/**
 * Stacks the ribbons on each chip's edge strictly in the order of their other
 * end's height (then family), centred on the chip, so two ribbons of one chip
 * never cross, at the chip or anywhere after it.
 */
function stackEdges(
  list: readonly Segment[],
  node: (key: string) => JourneyNode,
  sizes: Sizes,
  end: "from" | "to",
): Map<string, EdgeStack> {
  const other = end === "from" ? "to" : "from";
  const centre = (key: string) => node(key).y + node(key).h / 2;
  const order = (a: Segment, b: Segment) =>
    centre(a[other]) - centre(b[other]) ||
    node(a[other]).order - node(b[other]).order ||
    familyOrder(a.family, b.family) ||
    compareText(a.key, b.key);
  const out = new Map<string, EdgeStack>();
  for (const [ownerKey, segments] of groupBy(list, end)) {
    const sorted = [...segments].sort(order);
    const full = sorted.map((s) => sizes.t.get(s.key)!);
    const port = sorted.map((s) =>
      end === "from" ? (sizes.port.get(s.key) ?? sizes.t.get(s.key)!) : sizes.t.get(s.key)!,
    );
    const mid = centre(ownerKey);
    let fullY = mid - full.reduce((a, b) => a + b, 0) / 2;
    let portY = mid - port.reduce((a, b) => a + b, 0) / 2;
    sorted.forEach((segment, i) => {
      out.set(segment.key, {
        port: { y: round(portY), t: round(port[i]) },
        full: { y: round(fullY), t: round(full[i]) },
      });
      fullY += full[i];
      portY += port[i];
    });
  }
  return out;
}

/** How far a ribbon runs level out of and into its chips: the outer fifth of the gap at least, so every curve happens in the middle. */
function levelRun(gap: number): number {
  return Math.max(G.flatRun, gap * G.levelShare);
}

function placeRibbons(
  list: readonly Segment[],
  byKey: ReadonlyMap<string, JourneyNode>,
  sizes: Sizes,
): JourneyRibbon[] {
  const node = (key: string) => byKey.get(key)!;
  const out = stackEdges(list, node, sizes, "from");
  const into = stackEdges(list, node, sizes, "to");
  const busiest = Math.max(1, ...list.map((s) => s.turns));
  return (
    list
      .map((segment): JourneyRibbon => {
        const from = node(segment.from);
        const to = node(segment.to);
        const start = out.get(segment.key)!;
        const end = into.get(segment.key)!;
        const x0 = round(from.x + from.w);
        const x1 = round(to.x);
        const run = levelRun(x1 - x0);
        // Level out of the source, one swing in the middle, level into the target. Out of a
        // crowded start chip the ribbon leaves compressed and widens along that same swing,
        // so the fan opens in one smooth motion, with no second bend where it widens.
        const stations: RibbonStation[] = [
          { x: x0, ...start.port },
          { x: round(x0 + run), ...start.port },
          { x: round(x1 - run), ...end.port },
          { x: x1, ...end.port },
        ];
        const ribbon = {
          key: segment.key,
          from: segment.from,
          to: segment.to,
          family: segment.family,
          turns: segment.turns,
          x0,
          y0: start.port.y,
          t0: start.port.t,
          x1,
          y1: end.port.y,
          t1: end.port.t,
          stations,
          minor: segment.turns < busiest * 0.015,
          fold: isOtherKey(segment.from) || isOtherKey(segment.to),
          path: "",
        };
        return { ...ribbon, path: ribbonBand(ribbon) };
      })
      // Wide first, so a thin ribbon is painted over a wide one and stays visible.
      .sort((a, b) => b.t0 + b.t1 - (a.t0 + a.t1) || compareText(a.key, b.key))
  );
}

/** A link between two placed chips, for {@link placeJourneyRibbons}. */
export interface JourneyLink {
  key: string;
  from: string;
  to: string;
  family: number;
  turns: number;
}

/**
 * Ribbons for links between chips already placed, sized at `scale` and
 * stacked on each chip's edge exactly as the full map does it.
 */
export function placeJourneyRibbons(
  links: readonly JourneyLink[],
  nodes: readonly JourneyNode[],
  scale: number,
): JourneyRibbon[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const placed = links.filter((link) => byKey.has(link.from) && byKey.has(link.to));
  return placeRibbons(
    placed,
    byKey,
    sizeRibbons(placed, scale, (key) => key.startsWith("s:")),
  );
}

/* - Assembly ------------------------------------------------------------------ */

interface Placed {
  draft: Draft;
  order: number;
  y: number;
  slot: { top: number; height: number };
}

/** A lane stacked top down: the call columns, where every chip is one slot tall. */
function stackColumn(list: readonly Draft[]): Placed[] {
  let top: number = G.padTop;
  return list.map((draft, order) => {
    if (order > 0) top += G.chipGap + (draft.kind === "ended" ? G.endedGap : 0);
    const placed = { draft, order, y: round(top), slot: { top, height: G.chipH } };
    top += G.chipH;
    return placed;
  });
}

interface Block {
  /** Indexes into the lane, in order. */
  items: number[];
  top: number;
}

/**
 * The start and "Then" lanes: the chips keep their order and never overlap,
 * and sit as close as they can to the turn-weighted centre of the chips their
 * ribbons reach, busier chips pulling harder. Their fans then spread up and
 * down from the middle instead of diving to one end of the next column.
 *
 * Chips that would collide are placed as one block at the weighted best height
 * for all of them (pool adjacent violators), so a small chip above a big one
 * does not push the big one away from where its ribbons go.
 */
function centreColumn(
  list: readonly Draft[],
  segments: readonly Segment[],
  end: "from" | "to",
  centreOf: ReadonlyMap<string, number>,
): Placed[] {
  const other = end === "from" ? "to" : "from";
  const pitch = G.chipH + G.chipGap;
  const wants = list.map((draft) => {
    const mine = segments.filter((s) => s[end] === draft.key);
    const weight = mine.reduce((sum, s) => sum + s.turns, 0);
    const centre =
      weight > 0
        ? mine.reduce((sum, s) => sum + s.turns * (centreOf.get(s[other]) ?? 0), 0) / weight
        : G.padTop;
    return { top: centre - G.chipH / 2, weight: Math.max(1, weight) };
  });
  const bestTop = (items: readonly number[]) => {
    const total = items.reduce((sum, i) => sum + wants[i].weight, 0);
    return (
      items.reduce((sum, i, k) => sum + wants[i].weight * (wants[i].top - k * pitch), 0) / total
    );
  };
  const blocks: Block[] = [];
  list.forEach((_, index) => {
    let block: Block = { items: [index], top: wants[index].top };
    for (;;) {
      const previous = blocks[blocks.length - 1];
      if (!previous || previous.top + previous.items.length * pitch <= block.top) break;
      blocks.pop();
      const items = [...previous.items, ...block.items];
      block = { items, top: bestTop(items) };
    }
    blocks.push(block);
  });
  const shift = Math.max(0, G.padTop - (blocks[0]?.top ?? G.padTop));
  return blocks.flatMap((block) =>
    block.items.map((index, k) => {
      const top = round(block.top + shift + k * pitch);
      return { draft: list[index], order: index, y: top, slot: { top, height: G.chipH } };
    }),
  );
}

/** Lays out a journey. Null when there is nothing to draw. */
export function layoutJourney(
  journey: FlowJourney | undefined,
  options: JourneyLayoutOptions = {},
): JourneyLayout | null {
  if (!journey || journey.paths.length === 0 || journey.turns <= 0) return null;
  const calls = Math.max(1, lastCallReached(journey));
  const depth = Math.max(
    Math.min(calls, JOURNEY_VISIBLE_CALLS),
    Math.min(calls, Math.floor(options.depth ?? JOURNEY_VISIBLE_CALLS)),
  );
  const expanded = Object.fromEntries(
    Object.entries(options.expanded ?? {}).filter(
      ([k, v]) => Number(k) >= 1 && Number(k) <= depth && v > 0,
    ),
  ) as Record<number, number>;
  // An expanded map keeps its start and last-column chips where the plain map
  // (at the same depth) put them, so revealing tools moves only the column that grew.
  const anchor = Object.keys(expanded).length > 0 ? layoutJourney(journey, { depth }) : null;
  const labels = new Map(journey.tools.map((tool) => [tool.id, tool.label]));
  const families = familiesOf(journey, labels);
  const familyOf = new Map(families.map((f) => [f.id, f.index]));
  const shown = foldForDisplay(journey, depth, expanded);
  const routes: JourneyRoute[] = shown.paths
    .map((path) => ({
      keys: routeKeys(path, calls, depth),
      turns: path.turns,
      family: familyOf.get(path.tools[0] ?? "") ?? -1,
    }))
    .sort((a, b) => b.turns - a.turns || compareText(a.keys.join(">"), b.keys.join(">")));

  const drafts = draftNodes(routes, {
    journey,
    calls,
    depth,
    otherTools: shown.otherTools,
    expandable: shown.expandable,
    families: familyOf,
  });
  const roles: { role: JourneyColumnRole; call: number }[] = [
    { role: "start", call: 0 },
    ...Array.from({ length: depth }, (_, i) => ({ role: "call" as const, call: i + 1 })),
    depth < calls
      ? { role: "later" as const, call: depth + 1 }
      : { role: "then" as const, call: 0 },
  ];
  const WIDTH: Record<JourneyColumnRole, number> = {
    start: G.startWidth,
    call: G.callWidth,
    later: G.laterWidth,
    then: G.thenWidth,
    across: G.callWidth,
  };
  const widths = roles.map((r) => WIDTH[r.role]);
  // The first gap carries the widest fan, so it gets the most room.
  const firstGap = G.startGap;
  const otherGap = G.gap;
  const byColumn = roles.map((_, index) =>
    drafts.filter((d) => d.column === index).sort(nodeOrder),
  );
  let left: number = G.padX;
  const columns: JourneyColumn[] = roles.map((r, index) => {
    const column: JourneyColumn = {
      index,
      role: r.role,
      call: r.call,
      title: columnTitle(r.role, r.call),
      x: round(left),
      width: widths[index],
      turns: byColumn[index].filter((d) => d.kind !== "ended").reduce((sum, d) => sum + d.turns, 0),
    };
    left += widths[index] + (index === 0 ? firstGap : otherGap);
    return column;
  });

  // One ribbon scale for the map, set so the busiest tool chip holds its
  // ribbons inside its own edge.
  const busiestTool = Math.max(
    1,
    ...drafts
      .filter((d) => d.kind === "tool" || d.kind === "skill" || d.kind === "other")
      .map((d) => d.turns),
  );
  const scale = (G.chipH - 2 * G.bandInset) / busiestTool;
  const segments = segmentsOf(routes);
  // Thin links are left out of the drawing by default; their turns still count in every chip.
  const leaving = new Map<string, number>();
  for (const segment of segments)
    leaving.set(segment.from, (leaving.get(segment.from) ?? 0) + segment.turns);
  const drawn = options.showAll
    ? segments
    : segments.filter(
        (s) =>
          s.turns >= JOURNEY_LINK_MIN_TURNS &&
          s.turns >= JOURNEY_LINK_MIN_SHARE * (leaving.get(s.from) ?? 0),
      );
  const sizes = sizeRibbons(drawn, scale, (key) => key.startsWith("s:"));

  // Calls first, top down; then the start and "Then" lanes centred on what they reach.
  const placed = new Map<number, Placed[]>();
  byColumn.forEach((list, index) => {
    if (roles[index].role === "call") placed.set(index, stackColumn(list));
  });
  const centres = new Map<string, number>();
  for (const list of placed.values())
    for (const p of list) centres.set(p.draft.key, p.y + G.chipH / 2);
  const pinned = (index: number) => {
    if (!anchor) return null;
    const ys = new Map(anchor.nodes.filter((n) => n.column === index).map((n) => [n.key, n.y]));
    const list = byColumn[index];
    if (!list.every((d) => ys.has(d.key))) return null;
    return list.map((draft, order) => {
      const y = ys.get(draft.key)!;
      return { draft, order, y, slot: { top: y, height: G.chipH } };
    });
  };
  placed.set(0, pinned(0) ?? centreColumn(byColumn[0], segments, "from", centres));
  placed.set(
    roles.length - 1,
    pinned(roles.length - 1) ?? centreColumn(byColumn[roles.length - 1], segments, "to", centres),
  );

  const nodes: JourneyNode[] = [];
  let bottom: number = G.padTop;
  byColumn.forEach((_, index) => {
    const column = columns[index];
    for (const { draft, order, y, slot } of placed.get(index) ?? []) {
      nodes.push({
        ...draft,
        order,
        x: column.x,
        y,
        w: column.width,
        h: G.chipH,
        text: truncate(draft.label, labelRoom(column.width)),
        share: journey.turns > 0 ? draft.turns / journey.turns : 0,
      });
      bottom = Math.max(bottom, slot.top + slot.height);
    }
  });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const last = columns[columns.length - 1];
  return {
    calls,
    depth,
    expanded,
    width: round(last.x + last.width + G.padX),
    height: round(bottom + G.padBottom),
    scale,
    turns: journey.turns,
    columns,
    nodes,
    ribbons: placeRibbons(drawn, byKey, sizes),
    hiddenLinks: segments.length - drawn.length,
    routes,
    families,
  };
}

/** A ribbon's centreline height at `x`, for the checks on crossings and slopes. */
export function ribbonCentreAt(ribbon: JourneyRibbon, x: number): number {
  const bezier = (a: number, b: number, c: number, d: number, s: number) => {
    const u = 1 - s;
    return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d;
  };
  const stations = ribbon.stations;
  for (let i = 1; i < stations.length; i += 1) {
    const a = stations[i - 1];
    const b = stations[i];
    if (x > b.x + 1e-9 && i < stations.length - 1) continue;
    if (b.x - a.x < 1e-9) return b.y + b.t / 2;
    const mid = (a.x + b.x) / 2;
    let low = 0;
    let high = 1;
    for (let k = 0; k < 40; k += 1) {
      const s = (low + high) / 2;
      if (bezier(a.x, mid, mid, b.x, s) < x) low = s;
      else high = s;
    }
    const s = (low + high) / 2;
    return bezier(a.y, a.y, b.y, b.y, s) + bezier(a.t, a.t, b.t, b.t, s) / 2;
  }
  const last = stations[stations.length - 1];
  return last.y + last.t / 2;
}

/* - Focus --------------------------------------------------------------------- */

/** What lights when a chip is in focus: the turns through it, on every chip and ribbon. */
export interface JourneyFocus {
  node: string;
  turns: number;
  nodes: ReadonlyMap<string, number>;
  ribbons: ReadonlyMap<string, number>;
}

export function journeyFocus(layout: JourneyLayout, nodeKey: string): JourneyFocus {
  const nodes = new Map<string, number>();
  const ribbons = new Map<string, number>();
  let turns = 0;
  for (const route of layout.routes) {
    if (!route.keys.includes(nodeKey)) continue;
    turns += route.turns;
    route.keys.forEach((key, i) => {
      nodes.set(key, (nodes.get(key) ?? 0) + route.turns);
      const next = route.keys[i + 1];
      if (next === undefined) return;
      const family = familyInto(key, next, route.family);
      const ribbon = `${key}>${next}#${family}`;
      ribbons.set(ribbon, (ribbons.get(ribbon) ?? 0) + route.turns);
    });
  }
  return { node: nodeKey, turns, nodes, ribbons };
}

/** The tool id a chip key names (`c2:update_task` is `update_task`), or null for start and terminal chips. */
export function toolIdOf(key: string): string | null {
  return /^c\d+:/.test(key) ? key.slice(key.indexOf(":") + 1) : null;
}

/* - Text boxes ---------------------------------------------------------------- */

const TITLE_CHAR = 7;

/** Every place the map draws text: column titles and chips. Ribbons must never meet one. */
export function journeyTextBoxes(layout: JourneyLayout): Box[] {
  const titles = layout.columns.map((column) => {
    const chars = column.title.length + 2 + countText(column.turns).length;
    return { x: column.x, y: 2, w: chars * TITLE_CHAR, h: 16 };
  });
  return [
    ...titles,
    ...layout.nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })),
  ];
}

/** Whether two boxes share any area (touching edges do not count). */
export function boxesOverlap(a: Box, b: Box): boolean {
  const eps = 0.05;
  return (
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
  );
}

/* - Chip cards ---------------------------------------------------------------- */

/** The least room kept between a chip's edge and anything drawn inside it. */
export const JOURNEY_CHIP_PADDING = 8;

/**
 * The card a chip is drawn as, and the box its content may use. Most chips
 * fill their lane; "Ended" is a short tab (just wide enough for its words),
 * "+N tools" and "Later" leave room on the right for the cards stacked
 * behind them, and "More calls" for its arrow tip. Content keeps
 * {@link JOURNEY_CHIP_PADDING} from every edge.
 */
export interface ChipCard {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where content may start and must end, left to right. */
  contentLeft: number;
  contentRight: number;
  /** How far behind the front card the stacked cards reach (0 without a stack). */
  stack: number;
}

const STACK = 6;
const TIP = 11;

export function chipCard(
  node: Pick<JourneyNode, "kind" | "x" | "y" | "w" | "h" | "label" | "turns">,
): ChipCard {
  const base = { x: node.x, y: node.y, h: node.h, contentLeft: node.x + G.padL, stack: 0 };
  switch (node.kind) {
    case "ended": {
      const words = Math.max(node.label.length, countText(node.turns).length + 3);
      const w = Math.min(
        node.w,
        Math.max(Math.round(node.w * 0.62), Math.ceil(G.textX + words * G.charWidth + G.padR + 4)),
      );
      return { ...base, w, contentRight: node.x + w - G.padR - 4 };
    }
    case "other":
    case "later":
      return {
        ...base,
        w: node.w - STACK,
        contentRight: node.x + node.w - STACK - G.padR,
        stack: STACK,
      };
    case "more":
      return { ...base, w: node.w, contentRight: node.x + node.w - TIP - G.padR };
    default:
      return { ...base, w: node.w, contentRight: node.x + node.w - G.padR };
  }
}
