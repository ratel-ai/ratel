import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourneyTool } from "@/lib/readings/trace-signals/view";
import {
  chipText,
  JOURNEY_GRID,
  type JourneyColumn,
  type JourneyCrossLink,
  type JourneyDivider,
  type JourneyFocus,
  type JourneyNode,
} from "@/lib/views/health/flow-journey-layout";

/**
 * Prerequisites the journey cannot draw along a turn's calls, for the packed
 * prerequisites view. A tool the agent looks something up with, pauses, and
 * uses much later lands in two turns, so no turn's calls join them. (A pair a
 * turn did hold, but whose path the journey folded away, is drawn the same
 * way, with a solid link instead of a dashed one.)
 *
 * Each pair is one row under the packed journey, in its first two columns:
 * the tool that ran first, then the tool that needed it, joined by a direct
 * link. Its chips are keyed by the pair (`x:<first>><tool>:first` and
 * `:tool`), never a journey position, so they fade rather than glide when the
 * whole map comes back, and a tool in two pairs gets a chip in each row. With
 * no journey part (every pair crosses turns), the rows sit under two columns
 * of their own, titled "Ran first" and "Within 10 min".
 */

/** The key prefix of a chip or link for a pair the journey cannot draw. */
export const ACROSS_KEY = "x:";

const HEAD = 7;
const MIN_LINK = 1.5;
const MAX_LINK = 5;
/** Room between the packed journey and the rows under it, for a divider and its title. */
const DIVIDER_GAP = 34;

export type AcrossSide = "first" | "tool";

function pairKey(relation: Pick<JourneyPrerequisite, "first" | "tool">): string {
  return `${relation.first}>${relation.tool}`;
}

/** The chip of one side of a pair's row. */
export function acrossChipKey(
  relation: Pick<JourneyPrerequisite, "first" | "tool">,
  side: AcrossSide,
): string {
  return `${ACROSS_KEY}${pairKey(relation)}:${side}`;
}

/** The link of a pair's row. */
export function linkKey(relation: Pick<JourneyPrerequisite, "first" | "tool">): string {
  return `${ACROSS_KEY}${pairKey(relation)}`;
}

export function isAcrossKey(key: string): boolean {
  return key.startsWith(ACROSS_KEY);
}

/** The pair and side a row's chip stands for, or null for any other key. */
export function parseAcrossChip(
  key: string,
): { first: string; tool: string; side: AcrossSide } | null {
  if (!isAcrossKey(key)) return null;
  const body = key.slice(ACROSS_KEY.length);
  const colon = body.lastIndexOf(":");
  const side = body.slice(colon + 1);
  const arrow = body.indexOf(">");
  if (colon < 0 || arrow < 0 || (side !== "first" && side !== "tool")) return null;
  return { first: body.slice(0, arrow), tool: body.slice(arrow + 1, colon), side };
}

function weight(relation: JourneyPrerequisite): number {
  return relation.confidence * relation.turns;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The rows, heaviest pair first. */
export function acrossLinks(relations: readonly JourneyPrerequisite[]): JourneyPrerequisite[] {
  return [...relations].sort(
    (a, b) => weight(b) - weight(a) || compareText(pairKey(a), pairKey(b)),
  );
}

/** What lights for these pairs: their rows' chips and links, each as many uses as the pair counts. */
export function acrossFocus(
  relations: readonly JourneyPrerequisite[],
  node = "across",
): JourneyFocus {
  const nodes = new Map<string, number>();
  const ribbons = new Map<string, number>();
  let turns = 0;
  for (const relation of relations) {
    turns += relation.together;
    nodes.set(acrossChipKey(relation, "first"), relation.together);
    nodes.set(acrossChipKey(relation, "tool"), relation.together);
    ribbons.set(linkKey(relation), relation.together);
  }
  return { node, turns, nodes, ribbons };
}

export interface AcrossBand {
  /** Columns of their own, only when there is no journey part to sit under. */
  columns: JourneyColumn[];
  nodes: JourneyNode[];
  links: JourneyCrossLink[];
  dividers: JourneyDivider[];
}

export interface AcrossInput {
  relations: readonly JourneyPrerequisite[];
  tools: readonly FlowJourneyTool[];
  windowMinutes: number | null;
}

function windowTitle(windowMinutes: number | null): string {
  return windowMinutes ? `Within ${windowMinutes} min` : "Later in the session";
}

/**
 * The rows for pairs the journey cannot draw. `journey` holds the packed
 * journey's columns (empty when there is none) and `top` is where its chips
 * end; the rows go under it, in its first two columns.
 */
export function layoutAcross(
  input: AcrossInput,
  journey: readonly JourneyColumn[],
  top: number,
): AcrossBand {
  const rows = acrossLinks(input.relations);
  if (rows.length === 0) return { columns: [], nodes: [], links: [], dividers: [] };
  const width = JOURNEY_GRID.callWidth;
  const own = journey.length === 0;
  const x0 = JOURNEY_GRID.padX;
  const columns: JourneyColumn[] = own
    ? [0, 1].map((i) => ({
        index: i,
        role: "across",
        call: i,
        title: i === 0 ? "Ran first" : windowTitle(input.windowMinutes),
        x: x0 + i * (width + JOURNEY_GRID.gap),
        width,
        turns: 0,
      }))
    : [];
  const lanes = own ? columns : journey;
  const lane = (i: 0 | 1) =>
    lanes[i] ?? { index: -1, x: (lanes[0]?.x ?? x0) + i * (width + JOURNEY_GRID.gap), width };
  const start = own ? JOURNEY_GRID.padTop : top + DIVIDER_GAP;
  const pitch = JOURNEY_GRID.chipH + JOURNEY_GRID.chipGap;
  const byId = new Map(input.tools.map((tool) => [tool.id, tool]));
  const chip = (relation: JourneyPrerequisite, side: AcrossSide, row: number): JourneyNode => {
    const id = side === "first" ? relation.first : relation.tool;
    const tool = byId.get(id);
    const at = lane(side === "first" ? 0 : 1);
    const label = tool?.label ?? (side === "first" ? relation.firstLabel : relation.toolLabel);
    return {
      key: acrossChipKey(relation, side),
      id,
      kind: tool?.kind === "skill" ? "skill" : "tool",
      column: at.index,
      call: 0,
      label,
      text: chipText(label, at.width),
      tint: tool?.tint ?? "none",
      signalIds: tool?.signalIds ?? [],
      flags: tool?.flags ?? [],
      family: -1,
      turns: 0,
      share: 0,
      ended: 0,
      otherCount: null,
      expandable: 0,
      order: row,
      x: at.x,
      y: start + row * pitch,
      w: at.width,
      h: JOURNEY_GRID.chipH,
    };
  };
  const nodes = rows.flatMap((relation, row) => [
    chip(relation, "first", row),
    chip(relation, "tool", row),
  ]);
  const heaviest = Math.max(...rows.map((r) => r.together));
  const links = rows.map((relation, row): JourneyCrossLink => {
    const a = nodes[row * 2];
    const b = nodes[row * 2 + 1];
    const y = a.y + a.h / 2;
    const x1 = a.x + a.w;
    const x2 = b.x - HEAD;
    const width = MIN_LINK + (MAX_LINK - MIN_LINK) * Math.sqrt(relation.together / heaviest);
    const half = Math.max(3.5, width / 2 + 2.5);
    return {
      key: linkKey(relation),
      from: a.key,
      to: b.key,
      relationKey: pairKey(relation),
      turns: relation.together,
      width,
      crossTurn: relation.crossTurn === true,
      path: `M${x1} ${y} L${x2} ${y}`,
      head: `M${x2} ${y - half} L${b.x} ${y} L${x2} ${y + half} Z`,
      x1,
      y1: y,
      x2,
      y2: y,
    };
  });
  const dividers = own
    ? []
    : [{ y: top + 12, title: `${windowTitle(input.windowMinutes)} in the same session` }];
  return { columns, nodes, links, dividers };
}
