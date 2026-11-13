import type { MapLabel } from "@/components/console/intent-map/labels";
import { BADGE_RADIUS } from "@/components/console/intent-map/MapMarks";
import {
  type Circle,
  type LabelCandidate,
  type LabelChoice,
  type LabelObstacle,
  type Point,
  placeLabelChoices,
  type ViewTransform,
} from "@/lib/views/intents/map/map-geometry";
import type { ToolNetworkModel } from "@/lib/views/intents/map/tool-network";
import { labelAngle, type NameSide, nameSide } from "@/lib/views/intents/map/tool-network-layout";

/** On screen: a tool's name size and the box it is placed in. */
export const LABEL_FONT_PX = 12;
export const LABEL_HEIGHT = 16;
/** A name keeps this clear of every other tool's mark (screen pixels), so it never reads as that tool's. */
const LABEL_CLEARANCE = 12;
/** A hub's ring sits this far outside its mark (map units). */
const HUB_RING = 3.5;
/** At rest a longer tool name is cut in its middle to this many characters (DESIGN.md, Identifiers); pointed at, it is whole. */
export const REST_NAME_CHARS = 18;

/**
 * A tool id cut in its middle with an ellipsis, keeping whole words from its
 * start and its end (`sync…workflow`, `claim_task…branch`): the first and
 * last words always, then more from the start, else the end, while it stays
 * within `max`. An id without word breaks is cut by characters.
 */
export function middleCut(name: string, max: number = REST_NAME_CHARS): string {
  if (name.length <= max) return name;
  const words = name.split(/(?<=[_.-])/u);
  if (words.length < 3) {
    const head = Math.ceil((max - 1) / 2);
    return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
  }
  let start = 1;
  let end = words.length - 1;
  const text = () =>
    `${words
      .slice(0, start)
      .join("")
      .replace(/[_.-]$/u, "")}…${words.slice(end).join("")}`;
  // Grow from the start while it fits, else from the end, while there is a middle left to cut.
  while (start + 1 < end) {
    const longerStart = `${words
      .slice(0, start + 1)
      .join("")
      .replace(/[_.-]$/u, "")}…${words.slice(end).join("")}`;
    const longerEnd = `${words
      .slice(0, start)
      .join("")
      .replace(/[_.-]$/u, "")}…${words.slice(end - 1).join("")}`;
    if (longerStart.length <= max) start += 1;
    else if (longerEnd.length <= max) end -= 1;
    else break;
  }
  return text();
}

/** Which side of its mark each tool's name goes first: away from its links, or from the middle when it has none. */
export function nameSides(
  network: Pick<ToolNetworkModel, "nodes" | "links">,
  marks: ReadonlyMap<string, Circle>,
): Map<string, NameSide> {
  const all = [...marks.values()];
  const middle = {
    x: all.reduce((sum, mark) => sum + mark.x, 0) / Math.max(1, all.length),
    y: all.reduce((sum, mark) => sum + mark.y, 0) / Math.max(1, all.length),
  };
  const partnersOf = new Map<string, Point[]>();
  for (const link of network.links) {
    const a = marks.get(link.source);
    const b = marks.get(link.target);
    if (!link.backbone || !a || !b) continue;
    partnersOf.set(link.source, [...(partnersOf.get(link.source) ?? []), b]);
    partnersOf.set(link.target, [...(partnersOf.get(link.target) ?? []), a]);
  }
  return new Map(
    network.nodes.flatMap((node): Array<[string, NameSide]> => {
      const mark = marks.get(node.id);
      return mark
        ? [[node.id, nameSide(labelAngle(mark, partnersOf.get(node.id) ?? [], middle))]]
        : [];
    }),
  );
}

/**
 * On the globe, a name faces out: to the left of its mark in the disc's left
 * half, to the right elsewhere, so names spill outward into the free space
 * beside the disc rather than across it.
 */
export function globeSides(
  marks: ReadonlyMap<string, Circle>,
  centre: Point = { x: 0, y: 0 },
): Map<string, NameSide> {
  return new Map(
    [...marks].map(([id, mark]): [string, NameSide] => [
      id,
      mark.x < centre.x - 1 ? "left" : "right",
    ]),
  );
}

/** Where a missing tool's warning badge sits on screen: on the mark's upper right. */
export function badgeAt(mark: Circle, t: ViewTransform): Point {
  const out = mark.r * t.k * Math.SQRT1_2 + 5;
  return { x: mark.x * t.k + t.x + out, y: mark.y * t.k + t.y - out };
}

/**
 * The tool names drawn at one zoom, on screen: each tool's name tries the
 * side it faces first, then the other sides and half a line up or down from
 * them, and takes the first spot clear of the names already placed and of
 * every other tool's mark (`placeLabelChoices`). The `must` names come first
 * and may sit over a mark when nothing else fits; then `also`; then linked
 * tools busiest first, lone ones last. With `everyName`, every name may sit
 * over a mark.
 */
export function networkLabels(input: {
  network: Pick<ToolNetworkModel, "nodes">;
  marks: ReadonlyMap<string, Circle>;
  sides: ReadonlyMap<string, NameSide>;
  widths: ReadonlyMap<string, number>;
  view: ViewTransform;
  /** The part of the canvas names may use (above the readout and legend). */
  area: { width: number; height: number };
  must: Iterable<string | null>;
  also: Iterable<string>;
  everyName: boolean;
  /** Boxes already drawn on screen (the homes' names) that no tool's name may cover. */
  taken?: readonly LabelCandidate[];
  /** Tools drawn with a ring around their mark (shared by many tasks); hubs when not given. */
  ringed?: ReadonlySet<string>;
}): MapLabel[] {
  const { marks, view } = input;
  const nodes = new Map(input.network.nodes.map((node) => [node.id, node]));
  const ringed = (id: string) =>
    input.ringed ? input.ringed.has(id) : Boolean(nodes.get(id)?.hub);
  const ranked: Array<LabelChoice<MapLabel>> = [];
  const seen = new Set<string>();
  const add = (id: string | null, fallback: boolean, whole = false) => {
    const node = id ? nodes.get(id) : undefined;
    const mark = id ? marks.get(id) : undefined;
    if (!id || seen.has(id) || !node || !mark) return;
    seen.add(id);
    const sx = mark.x * view.k + view.x;
    const sy = mark.y * view.k + view.y;
    const out = (ringed(id) ? mark.r + HUB_RING : mark.r) * view.k + 5;
    const side = input.sides.get(id) ?? "right";
    const spotsFor = (text: string): { facing: MapLabel[]; rest: MapLabel[] } => {
      // Mono: a cut name's width is its share of the whole name's.
      const width = ((input.widths.get(id) ?? 0) * text.length) / Math.max(1, node.name.length);
      const base = { id, height: LABEL_HEIGHT, lines: [text], kind: "capability" as const, width };
      const right: MapLabel = {
        ...base,
        x: sx + out + width / 2,
        y: sy,
        anchor: "start",
        textX: sx + out,
        textY: sy,
      };
      const left: MapLabel = {
        ...base,
        x: sx - out - width / 2,
        y: sy,
        anchor: "end",
        textX: sx - out,
        textY: sy,
      };
      const below: MapLabel = {
        ...base,
        x: sx,
        y: sy + out + 5,
        anchor: "middle",
        textX: sx,
        textY: sy + out + 5,
      };
      const above: MapLabel = {
        ...base,
        x: sx,
        y: sy - out - 5,
        anchor: "middle",
        textX: sx,
        textY: sy - out - 5,
      };
      // Half a line up or down from the side spots, for a name that a neighbour's name blocks.
      const lift = LABEL_HEIGHT * 0.75;
      const shifted = [right, left].flatMap((spot) =>
        [-lift, lift].map((dy): MapLabel => ({ ...spot, y: sy + dy, textY: sy + dy })),
      );
      const first = { right, left, below, above }[side];
      // The side it faces first, then the same side half a line up or down, then the rest.
      const facing =
        side === "right" ? shifted.slice(0, 2) : side === "left" ? shifted.slice(2) : [];
      return {
        facing: [first, ...facing],
        rest: [right, left, below, above, ...shifted].filter(
          (spot) => spot !== first && !facing.includes(spot),
        ),
      };
    };
    // The whole name on the side it faces, else cut in its middle there (at rest), then the other sides the same way.
    const full = spotsFor(node.name);
    const cutName = whole || input.everyName ? node.name : middleCut(node.name);
    const cut = cutName === node.name ? null : spotsFor(cutName);
    const spots = [...full.facing, ...(cut?.facing ?? []), ...full.rest, ...(cut?.rest ?? [])];
    ranked.push({ id, owners: [`mark:${id}`], spots, fallback });
  };
  for (const id of input.must) add(id, true, true);
  for (const id of input.also) add(id, input.everyName);
  // Linked tools are the story, so they are named first, busiest first; lone ones after.
  const byInterest = [...input.network.nodes].sort(
    (a, b) =>
      Number(b.partners > 0) - Number(a.partners > 0) ||
      b.calls - a.calls ||
      (a.id < b.id ? -1 : 1),
  );
  for (const node of byInterest) add(node.id, input.everyName);
  // Other tools' marks are in the way of a name, with room to spare (softly: a name that must show may
  // cover one); warning badges always are.
  const obstacles: LabelObstacle[] = [
    ...[...marks].map(([id, mark]) => ({
      id: `mark:${id}`,
      x: mark.x * view.k + view.x,
      y: mark.y * view.k + view.y,
      r: (ringed(id) ? mark.r + HUB_RING : mark.r) * view.k + LABEL_CLEARANCE,
      soft: true,
    })),
    ...input.network.nodes.flatMap((node) => {
      const mark = marks.get(node.id);
      return mark && node.missing
        ? [{ id: `badge:${node.id}`, ...badgeAt(mark, view), r: BADGE_RADIUS }]
        : [];
    }),
  ];
  const spots = placeLabelChoices(ranked, obstacles, input.area, 3, input.taken ?? []);
  return ranked.flatMap((choice) => {
    const spot = spots.get(choice.id);
    return spot ? [spot] : [];
  });
}
