import type { StepFlowQuery } from "@/lib/contracts/query";
import type { StepFlowMark, StepFlowResult } from "@/lib/synthesis/metrics/step-flow";
import {
  compare,
  foldStepFlow,
  type StepFlowColumn,
  type StepFlowExpanded,
  type StepFlowFold,
  type StepFlowNodeCount,
} from "@/lib/synthesis/metrics/step-flow-columns";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  familyInto,
  JOURNEY_CHIP,
  JOURNEY_FAMILIES,
  JOURNEY_GRID,
  type JourneyLayout,
  type JourneyLink,
  type JourneyNode,
  type JourneyNodeKind,
  ordinal,
  placeJourneyRibbons,
} from "@/lib/views/health/flow-journey-layout";

/**
 * What the step flow widget draws: the fold's columns as lanes of cards, with the Health map's own
 * ribbons between them. Pure. In mode before, time runs left to right too: the start is on the right.
 */

/** Nodes one press on a bucket takes out of it. */
export const EXPAND_STEP = 3;
/** The width of a card before the browser measures the widget. */
const USUAL_WIDTH = 1080;
const CARD = { min: 124, max: 208 } as const;
const GAP = { start: 72, step: 44 } as const;
const { padX, padTop, padBottom, chipH, chipGap } = JOURNEY_GRID;

export interface StepFlowCard extends StepFlowNodeCount {
  x: number;
  y: number;
  w: number;
  h: number;
  step: number;
  /** The colour of its paths, from 0; -1 without one. */
  family: number;
  mark: StepFlowMark | null;
}

export interface StepFlowLane extends Omit<StepFlowColumn, "nodes"> {
  x: number;
  width: number;
  title: string;
  cards: StepFlowCard[];
}

export interface StepFlowModel {
  total: number;
  /** The steps with a lane of their own. */
  depth: number;
  /** The steps the paths hold: what Later can be opened to. */
  reached: number;
  /** Left to right. */
  lanes: StepFlowLane[];
  /** The same drawing for the Health map's parts: ribbons, routes and places. */
  layout: JourneyLayout;
}

export interface StepFlowView {
  /** The widget's, in pixels; 0 before it is measured. */
  width: number;
  expanded?: StepFlowExpanded;
  /** Steps opened out of Later. */
  opened?: number;
}

export function stepFlowModel(
  result: Pick<StepFlowResult, "names" | "paths" | "marks">,
  query: Pick<StepFlowQuery, "node" | "mode" | "target" | "steps" | "nodes">,
  { width: measured, expanded = {}, opened = 0 }: StepFlowView,
): StepFlowModel {
  const width = measured || USUAL_WIDTH;
  const reached = Math.max(0, ...result.paths.map(({ steps }) => steps.length));
  // What fits, but never less than one step; what a person opens may scroll.
  const steps = Math.max(1, Math.min(query.steps, fitting(width))) + opened;
  const fold = foldStepFlow(result, { steps, nodes: query.nodes }, expanded);
  const before = query.mode === "before";
  const ordered = before ? fold.columns.toReversed() : fold.columns;
  const places = lanePlaces(ordered, width);
  const families = familiesOf(fold);
  const familyOf = (name: string | null) => (name === null ? -1 : (families.get(name) ?? -1));
  const stacked = ordered.map(({ nodes }) => nodes.length * (chipH + chipGap) - chipGap);
  const tallest = Math.max(chipH, ...stacked);
  const lanes = ordered.map(({ nodes, ...column }, index): StepFlowLane => {
    const { x, width: w } = places[index];
    // The two ends sit at the middle of what they lead to.
    const top =
      column.role === "step" ? padTop : padTop + Math.max(0, (tallest - stacked[index]) / 2);
    return {
      ...column,
      x,
      width: w,
      title: laneTitle(column, query),
      cards: nodes.map((node, order) => ({
        ...node,
        step: column.step,
        x,
        y: top + order * (chipH + chipGap),
        w,
        h: chipH,
        family: node.kind === "node" ? familyOf(node.name) : -1,
        mark:
          node.kind === "node"
            ? (result.marks.find((mark) => mark.step === column.step && mark.name === node.name) ??
              null)
            : null,
      })),
    };
  });
  const last = places[places.length - 1];
  const nodes = lanes.flatMap(({ cards }, column) =>
    cards.map((card, order) => journeyNode(card, column, order)),
  );
  const busiest = Math.max(
    1,
    ...fold.columns.flatMap(({ role, nodes: own }) =>
      role === "step" ? own.filter(({ kind }) => kind !== "ended").map(({ count }) => count) : [],
    ),
  );
  const scale = (chipH - 2 * JOURNEY_CHIP.bandInset) / busiest;
  const routes = fold.routes.map(({ keys, first, count }) => ({
    keys: before ? keys.toReversed() : keys,
    family: familyOf(first),
    turns: count,
  }));
  const depth = fold.columns.length - 2;
  return {
    total: fold.total,
    depth,
    reached,
    lanes,
    layout: {
      calls: reached,
      depth,
      expanded,
      width: last.x + last.width + padX,
      height: padTop + tallest + padBottom,
      hiddenLinks: 0,
      scale,
      turns: fold.total,
      columns: lanes.map(({ role, step, title, x, width: w, count }, index) => ({
        index,
        role: role === "step" ? "call" : role,
        call: step,
        title,
        x,
        width: w,
        turns: count,
      })),
      nodes,
      ribbons: placeJourneyRibbons(journeyLinks(routes), nodes, scale),
      routes,
      families: [...families].map(([name, index]) => ({ index, id: name, label: name })),
    },
  };
}

/** "Later" opens on this step: the next one its traces made. */
export function laterLabel(
  { step }: Pick<StepFlowCard, "step">,
  query: Pick<StepFlowQuery, "node" | "mode" | "target">,
): string {
  return laneTitle({ role: "step", step }, query);
}

/** What a card says, in one line. */
export function cardLabel(
  card: StepFlowCard,
  query: Pick<StepFlowQuery, "node" | "mode" | "target">,
): string {
  const traces = `${formatInteger(card.count)} trace${card.count === 1 ? "" : "s"}`;
  switch (card.kind) {
    case "start":
      return `${card.name}, ${query.mode === "before" ? `before ${query.target}` : "start"}: ${traces}`;
    case "ended":
      return query.mode === "before"
        ? `Nothing earlier: ${traces}`
        : `Ended ${card.step === 1 ? "without a step" : `after step ${card.step - 1}`}: ${traces}`;
    case "later":
      return `${query.mode === "before" ? "Earlier" : "Later"} steps, from the ${ordinal(card.step)}: ${traces}`;
    default: {
      const place = `step ${card.step}${query.mode === "before" ? " before" : ""}`;
      const name = card.kind === "rest" ? `${card.folded} more` : card.name;
      const marks = [card.mark?.errors && "often fails", card.mark?.slow && "slow"].filter(Boolean);
      return [`${name}, ${place}: ${traces}`, ...marks].join(", ");
    }
  }
}

/** The steps whose lanes have room, with a start and a Later. */
function fitting(width: number): number {
  const ends = 2 * padX + 2 * CARD.min + GAP.start + CARD.min + GAP.step;
  return 1 + Math.max(0, Math.floor((width - ends) / (CARD.min + GAP.step)));
}

/** The gap beside the start carries the widest fan. */
function lanePlaces(
  columns: readonly Pick<StepFlowColumn, "role">[],
  width: number,
): { x: number; width: number }[] {
  const gapAfter = (index: number): number =>
    [columns[index]?.role, columns[index + 1]?.role].includes("start") ? GAP.start : GAP.step;
  const gaps = columns.slice(0, -1).map((_, index) => gapAfter(index));
  const gapWidth = gaps.reduce((sum, gap) => sum + gap, 0);
  const room = width - 2 * padX - gapWidth;
  const card = Math.min(CARD.max, Math.max(CARD.min, Math.floor(room / columns.length)));
  const spare = Math.max(0, Math.floor((room - card * columns.length) / Math.max(1, gaps.length)));
  let x: number = padX;
  return columns.map((_, index) => {
    const place = { x, width: card };
    x += card + (gaps[index] ?? 0) + spare;
    return place;
  });
}

function laneTitle(
  { role, step }: Pick<StepFlowColumn, "role" | "step">,
  { mode, node, target }: Pick<StepFlowQuery, "mode" | "node" | "target">,
): string {
  if (role === "start") return mode === "before" ? (target ?? "") : "Start";
  if (role === "later") return mode === "before" ? "Earlier" : "Later";
  if (mode === "before") return `${ordinal(step)} before`;
  return `${ordinal(step)} ${STEP_NOUN[node]}`;
}

const STEP_NOUN: Readonly<Record<StepFlowQuery["node"], string>> = {
  tool: "call",
  skill: "skill",
  agent: "agent",
  mcp_server: "server",
  model: "model",
};

/** The busiest first steps get a colour of their own. */
function familiesOf({ routes }: Pick<StepFlowFold, "routes">): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { first, count } of routes)
    if (first !== null) counts.set(first, (counts.get(first) ?? 0) + count);
  return new Map(
    [...counts]
      .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
      .slice(0, JOURNEY_FAMILIES)
      .map(([name], index) => [name, index]),
  );
}

function journeyLinks(routes: JourneyLayout["routes"]): JourneyLink[] {
  const links = new Map<string, JourneyLink>();
  for (const { keys, family: own, turns } of routes)
    for (const [at, to] of keys.slice(1).entries()) {
      const from = keys[at];
      const family = familyInto(from, to, own);
      const key = `${from}>${to}#${family}`;
      const link = links.get(key) ?? { key, from, to, family, turns: 0 };
      links.set(key, { ...link, turns: link.turns + turns });
    }
  return [...links.values()];
}

const JOURNEY_KIND: Readonly<Record<StepFlowNodeCount["kind"], JourneyNodeKind>> = {
  start: "agent",
  node: "tool",
  rest: "other",
  ended: "ended",
  later: "later",
};

function journeyNode(card: StepFlowCard, column: number, order: number): JourneyNode {
  const { key, kind, name, step, family, count, share, folded, x, y, w, h } = card;
  return {
    ...{ key, column, order, family, share, x, y, w, h },
    id: name,
    kind: JOURNEY_KIND[kind],
    call: step,
    label: name,
    text: name,
    tint: "none",
    signalIds: [],
    flags: [],
    turns: count,
    ended: 0,
    otherCount: folded || null,
    expandable: folded,
  };
}
