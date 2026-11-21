import { MEASURE_PX, type TextMeasures } from "@/components/console/intent-map/measure";
import type { LabelChoice, ViewTransform } from "@/lib/views/intents/map/map-geometry";
import type { LayoutGroup, LayoutNode } from "@/lib/views/intents/map/map-membership";
import type { MapAsk, MapCapability } from "@/lib/views/intents/map/map-model";
import {
  type FittedName,
  fitNameShrinking,
  NAME_MIN_PX,
  nameFontAt,
  nameRoom,
} from "@/lib/views/intents/map/map-names";

/** On screen, the line height of a tool's name. */
export const TOOL_LINE_HEIGHT = 15;
/** Tool names are a fixed size on screen (DESIGN.md's smallest text). */
const TOOL_FONT_PX = 12;

/** A tool's name placed on screen: its box for collisions and where its text is drawn from. */
export type MapLabel = {
  id: string;
  /** Centre of the label's box, for collisions. */
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  kind: "capability";
  /** Circles this spot may overlap, when they differ from its label's. */
  owners?: readonly string[];
  anchor: "start" | "middle" | "end";
  textX: number;
  textY: number;
};

/** A group's name as drawn at one zoom: inside its blob, in map units. */
export type GroupNameSpot = FittedName & { id: string; x: number; y: number };

/**
 * A group's name at zoom `k`: at its blob's visual centre, wrapped to the room
 * there (less the warning mark's when it has one), shrunk toward the readable
 * floor before its last line is cut with an ellipsis. Null when it would be
 * too small to read on screen or not even a few letters fit: hidden, never
 * spilled.
 */
export function groupNameAt(
  ask: MapAsk,
  group: LayoutGroup,
  k: number,
  measures: TextMeasures,
  badgeRadius: number,
): GroupNameSpot | null {
  const fontSize = nameFontAt(group.nameSize, k);
  if (fontSize === null) return null;
  const room = nameRoom(group.name, ask.problem ? group.badge : null, badgeRadius, k);
  // One on-screen pixel at a time, down to the smallest a name is drawn.
  const fitted = fitNameShrinking(
    ask.label,
    room,
    fontSize,
    Math.min(fontSize, NAME_MIN_PX / k),
    (size) => (text) => measures.sans(text) * (size / MEASURE_PX),
    1 / k,
  );
  return fitted ? { ...fitted, id: ask.id, x: group.name.x, y: group.name.y } : null;
}

/** A drawn name's box on screen, for keeping tool names off it. */
export function nameBox(name: GroupNameSpot, t: ViewTransform) {
  return {
    id: `name:${name.id}`,
    x: name.x * t.k + t.x,
    y: name.y * t.k + t.y,
    width: Math.max(...name.widths) * t.k,
    height: name.lines.length * name.lineHeight * t.k,
  };
}

/**
 * Where a tool's name may go: away from the intent that holds it first, then
 * the other sides. Keyed by the mark (`node.id`): a tool has one in each
 * intent it serves.
 */
export function toolLabel(
  capability: MapCapability,
  node: LayoutNode,
  t: ViewTransform,
  measures: TextMeasures,
): LabelChoice<MapLabel> {
  const width = measures.mono(capability.name) * (TOOL_FONT_PX / MEASURE_PX);
  const sx = node.x * t.k + t.x;
  const sy = node.y * t.k + t.y;
  const out = node.r * t.k + 6;
  const base = {
    id: node.id,
    height: 16,
    lines: [capability.name],
    kind: "capability" as const,
    width,
  };
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
    y: sy + out + 4,
    anchor: "middle",
    textX: sx,
    textY: sy + out + 4,
  };
  const above: MapLabel = {
    ...base,
    x: sx,
    y: sy - out - 4,
    anchor: "middle",
    textX: sx,
    textY: sy - out - 4,
  };
  const angle = node.angle;
  const outward =
    angle === null
      ? right
      : Math.cos(angle) > 0.35
        ? right
        : Math.cos(angle) < -0.35
          ? left
          : Math.sin(angle) >= 0
            ? below
            : above;
  return {
    id: node.id,
    owners: [...node.groups, `mark:${node.id}`],
    spots: [outward, ...[right, below, left, above].filter((spot) => spot !== outward)],
  };
}
