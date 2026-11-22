/**
 * Which blob a tool belongs to on the intent map, and the sizes and spacing
 * the drawing keeps. Where a tool sits follows how many groups it answers:
 * - one group: inside that group's blob, on a ring just outside its core, so
 *   near the edge but clearly inside, never on the outline;
 * - two or three: those groups are pulled together and the tool sits between
 *   them; each of their blobs is drawn to hold it, so it lives where they
 *   overlap, the way a Venn diagram says "both";
 * - four or more (`WIDE_FROM`): three blobs can meet around one spot, a fourth
 *   cannot without crowding the rest, so such a tool sits outside every blob,
 *   in the clear space between the groups it serves, and lights them up when
 *   it is pointed at.
 */
import { BLOB_WOBBLE, type Blob } from "@/lib/views/intents/map/map-blobs";
import type { Bounds, Circle, Point } from "@/lib/views/intents/map/map-geometry";
import type { MapLink } from "@/lib/views/intents/map/map-model";

/** From this many groups, a tool sits outside them, between the groups it serves. */
export const WIDE_FROM = 4;
/** A group's core, by how busy it is (map units): its name sits inside. */
export const CORE_RADIUS = { min: 22, max: 64 };
/** A tool's mark, by its calls (map units). */
export const TOOL_RADIUS = { min: 3.5, max: 7 };
/** Between a core and the ring of tools its group holds. */
export const RING_GAP = 3;
/** A blob's edge beyond each tool it holds: clearly inside, never on the outline. */
export const TOOL_PAD = 6;
/** A blob's edge beyond its core where it holds no tool. */
export const CORE_PAD = 3;
/** Between blobs that share nothing. */
export const GAP = 16;
/** A widely shared tool keeps this clear of every blob. */
export const WIDE_CLEAR = 8;
/** Between two tool marks. */
export const TOOL_GAP = 4;
/** The share of a ring its tools may fill; a group holding more gets a wider ring. */
export const RING_FILL = 0.55;

export type Membership = "single" | "shared" | "wide";

export interface ToolMembership {
  membership: Membership;
  /** The groups it answers, busiest link first, ties by id. */
  groups: string[];
}

/**
 * How many groups each tool answers decides where it sits: one is `single`,
 * two or three `shared`, `WIDE_FROM` or more `wide`. A link with no calls
 * places nothing.
 */
export function toolMemberships(
  links: ReadonlyArray<Pick<MapLink, "ask" | "capability" | "weight">>,
  wideFrom: number = WIDE_FROM,
): Map<string, ToolMembership> {
  const users = new Map<string, Array<{ ask: string; weight: number }>>();
  for (const link of links) {
    if (!(link.weight > 0)) continue;
    users.set(link.capability, [
      ...(users.get(link.capability) ?? []),
      { ask: link.ask, weight: link.weight },
    ]);
  }
  const out = new Map<string, ToolMembership>();
  for (const [capability, list] of users) {
    const ordered = [...list].sort(
      (a, b) => b.weight - a.weight || (a.ask < b.ask ? -1 : a.ask > b.ask ? 1 : 0),
    );
    const groups = [...new Set(ordered.map((user) => user.ask))];
    out.set(capability, {
      membership: groups.length === 1 ? "single" : groups.length < wideFrom ? "shared" : "wide",
      groups,
    });
  }
  return out;
}

/** How close a tool may come to the centre of a group that holds it: never onto the core, where the name sits. */
export function coreClearance(core: number, tool: number): number {
  return core + RING_GAP + tool;
}

/**
 * A group's rings, from its core and the radii of the tools it holds: the ring
 * its tools sit on, just outside the core (wider when they would crowd it);
 * the round body its blob is drawn around, a pad beyond the ring's tools; and
 * how far the wobbled outline can reach.
 */
export interface GroupRings {
  core: number;
  ring: number;
  body: number;
  reach: number;
}

export function groupRings(core: number, held: readonly number[]): GroupRings {
  if (held.length === 0) {
    const body = core + CORE_PAD;
    return { core, ring: core, body, reach: body * (1 + BLOB_WOBBLE) + 1 };
  }
  const biggest = Math.max(...held);
  const around = held.reduce((sum, tool) => sum + 2 * tool + TOOL_GAP, 0);
  const ring = Math.max(core + RING_GAP + biggest, around / (Math.PI * 2 * RING_FILL));
  const body = ring + biggest + TOOL_PAD;
  return { core, ring, body, reach: body * (1 + BLOB_WOBBLE) + 1 };
}

// --- what the layout hands the map ------------------------------------------------

export interface LayoutGroup {
  ask: string;
  /** The core: a circle as large as the group is busy (map units). */
  x: number;
  y: number;
  r: number;
  /** The shape drawn: around the core and the tools it holds. */
  blob: Blob;
  /** Where the name sits (the blob's visual centre) and the room it has there. */
  name: Circle;
  /** The name's size in map units. */
  nameSize: number;
  /** Where a warning mark sits on the outline when the group needs a look. */
  badge: Point;
}

/**
 * Where a tool is drawn: inside its one group's blob, in the overlap of its
 * two or three, or between the groups it serves, outside every blob (a widely
 * shared tool, or one whose groups the layout could not bring together).
 */
export type Placement = "inside" | "overlap" | "between";

export interface LayoutNode {
  /** `tool:…` or `skill:…`. */
  id: string;
  kind: "tool" | "skill";
  x: number;
  y: number;
  r: number;
  membership: Membership;
  placement: Placement;
  /** The groups it answers, busiest first. */
  groups: readonly string[];
  /** The way its name faces, away from the one group that holds it (radians); null when any side will do. */
  angle: number | null;
}

export interface MapLayout {
  groups: Map<string, LayoutGroup>;
  nodes: Map<string, LayoutNode>;
  width: number;
  height: number;
  /** Everything drawn: the blobs and the tools outside them. */
  bounds: Bounds;
}
