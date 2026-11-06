/**
 * Where every tool sits once the groups are packed, and the shapes drawn from
 * that. Every tool ends up where its membership says: inside the one blob it
 * belongs to, in the overlap of its two or three, or outside every blob,
 * between the groups it serves. Then the blobs, each name's room and each
 * warning mark's spot. Pure, so the rules are tested on their own.
 */
import {
  type Blob,
  blobOutline,
  blobPointAt,
  boundsMeet,
  signedDistance,
} from "@/lib/views/intents/map/map-blobs";
import type { Bounds, Circle, Point } from "@/lib/views/intents/map/map-geometry";
import {
  CORE_RADIUS,
  coreClearance,
  type GroupRings,
  groupRings,
  type LayoutGroup,
  type LayoutNode,
  type MapLayout,
  type Membership,
  type Placement,
  TOOL_GAP,
  TOOL_PAD,
  WIDE_CLEAR,
} from "@/lib/views/intents/map/map-membership";
import { nameCircle, nameSize } from "@/lib/views/intents/map/map-names";

/** Where a warning mark may sit on an outline, best first: top right, then around. */
const BADGE_ANGLES = [
  -Math.PI / 4,
  (-3 * Math.PI) / 4,
  -Math.PI / 2,
  Math.PI / 4,
  (3 * Math.PI) / 4,
  0,
  Math.PI,
];
/** A warning mark keeps this clear of the tools on its outline (map units). */
const BADGE_CLEAR = 14;
/** A name keeps this clear of the tools its group holds (map units), on top of its margin. */
const NAME_TOOL_CLEAR = 2;
/** Spots tried around a ring. */
const RING_STEPS = 144;
/** Tools a group holds sit this much further apart than they must, so they read as separate marks. */
const RING_COMFORT = 1.6;
/** Held tools gather at the bottom of their ring (screen y runs down). */
const RING_PREFER = Math.PI / 2;
/** Rings tried past a group's own when its partners leave no room on it, and the extra room a bulge keeps from other blobs. */
const BULGE_RINGS = 3;
const BULGE_CLEAR = 3;
/** Spots tried across the space between a shared tool's groups, then around the best of them. */
const MEET_GRID = 24;
/** How far out a tool shared widely may be set from the middle of its groups (map units), and the step. */
const BETWEEN_SEARCH = { reach: 600, step: 4 };
/**
 * How far a blob may bulge past its round body to hold a tool it shares, as a
 * share of that body. A shared tool its groups could only hold by bulging
 * further would stretch a blob into an arm across the map, so it is drawn
 * between them instead.
 */
export const STRETCH_ALLOW = 0.25;

export interface GroupSpot {
  id: string;
  x: number;
  y: number;
  /** The core's radius. */
  r: number;
}

export interface ToolSpot {
  id: string;
  kind: "tool" | "skill";
  r: number;
  membership: Membership;
  groups: readonly string[];
  /** Where the packing left its point: where a shared tool's groups meet, or where a group made room for its own tool. */
  hint?: Point;
}

type Placed = { x: number; y: number; r: number };
type PackedGroup = GroupSpot & { rings: GroupRings };

/** The tools each group holds: its own, and the ones it shares with one or two others. */
export function heldTools<Tool extends Pick<ToolSpot, "membership" | "groups">>(
  tools: readonly Tool[],
): Map<string, Tool[]> {
  const held = new Map<string, Tool[]>();
  for (const tool of tools) {
    if (tool.membership === "wide") continue;
    for (const group of tool.groups) held.set(group, [...(held.get(group) ?? []), tool]);
  }
  return held;
}

/** The discs a group's blob is drawn around: its round body and each tool it holds, padded. */
export function heldDiscs(centre: Point, rings: GroupRings, tools: readonly Placed[]): Circle[] {
  return [
    { x: centre.x, y: centre.y, r: rings.body },
    ...tools.map((tool) => ({ x: tool.x, y: tool.y, r: tool.r + TOOL_PAD })),
  ];
}

/** Whether a mark, with `clear` to spare, reaches into `blob`. */
export function intrudes(mark: Placed, blob: Blob, clear: number): boolean {
  if (
    !boundsMeet(
      blob.bounds,
      { minX: mark.x, minY: mark.y, maxX: mark.x, maxY: mark.y },
      mark.r + clear,
    )
  )
    return false;
  return signedDistance(mark, blob.points) > -(mark.r + clear);
}

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * Where a tool two or three groups share sits: the spot deepest inside all of
 * their bodies (the middle of where they overlap), off their cores, clear of
 * every other group and of the tools already set. `bulge` is how far the tool,
 * padded, would stick out past the body of the group it is furthest from:
 * zero or less when every body holds it as it is, more when one of the blobs
 * has to bulge to hold it. Null when no spot is clear.
 *
 * Found by a compass search from a few starts (the packing's own spot for it,
 * the middle of the groups, a spot between each pair, the best of a coarse
 * sweep): each step tries the eight directions around and keeps the best,
 * halving the step when none is better. Running into a core, another group or
 * a tool costs far more than any bulge, so the search walks out of them.
 */
export function meetingSpot(
  tool: { r: number; hint?: Point },
  members: readonly PackedGroup[],
  others: readonly PackedGroup[],
  taken: readonly Placed[],
): { spot: Point; bulge: number } | null {
  const reach = Math.max(...members.map((group) => group.rings.body));
  const box = {
    minX: Math.min(...members.map((group) => group.x)) - reach,
    minY: Math.min(...members.map((group) => group.y)) - reach,
    maxX: Math.max(...members.map((group) => group.x)) + reach,
    maxY: Math.max(...members.map((group) => group.y)) + reach,
  };
  const near = (point: Point, room: number) =>
    point.x > box.minX - room &&
    point.x < box.maxX + room &&
    point.y > box.minY - room &&
    point.y < box.maxY + room;
  const blocking = others.filter((group) => near(group, group.rings.reach + tool.r + TOOL_PAD));
  const marks = taken.filter((mark) => near(mark, mark.r + tool.r + TOOL_GAP));
  const measure = (spot: Point) => {
    let bulge = -Infinity;
    let overlap = 0;
    for (const group of members) {
      const distance = Math.hypot(spot.x - group.x, spot.y - group.y);
      overlap += Math.max(0, coreClearance(group.r, tool.r) - distance);
      bulge = Math.max(bulge, distance + tool.r + TOOL_PAD - group.rings.body);
    }
    for (const group of blocking)
      overlap += Math.max(
        0,
        group.rings.reach + tool.r + TOOL_PAD - Math.hypot(spot.x - group.x, spot.y - group.y),
      );
    for (const mark of marks)
      overlap += Math.max(
        0,
        mark.r + tool.r + TOOL_GAP - Math.hypot(spot.x - mark.x, spot.y - mark.y),
      );
    return { bulge, overlap, cost: bulge + overlap * 100 };
  };
  const starts: Point[] = [
    ...(tool.hint ? [tool.hint] : []),
    {
      x: members.reduce((sum, group) => sum + group.x, 0) / members.length,
      y: members.reduce((sum, group) => sum + group.y, 0) / members.length,
    },
  ];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      const share = a.rings.body / (a.rings.body + b.rings.body);
      starts.push({ x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share });
    }
  }
  let sweep: { spot: Point; cost: number } | null = null;
  for (let i = 0; i <= MEET_GRID; i += 1) {
    for (let j = 0; j <= MEET_GRID; j += 1) {
      const spot = {
        x: box.minX + ((box.maxX - box.minX) * i) / MEET_GRID,
        y: box.minY + ((box.maxY - box.minY) * j) / MEET_GRID,
      };
      const { cost } = measure(spot);
      if (!sweep || cost < sweep.cost) sweep = { spot, cost };
    }
  }
  if (sweep) starts.push(sweep.spot);

  let best: { spot: Point; bulge: number } | null = null;
  for (const start of starts) {
    let spot = start;
    let current = measure(spot);
    let step = Math.max(2, (box.maxX - box.minX) / MEET_GRID);
    while (step > 0.1) {
      let moved = false;
      for (let direction = 0; direction < 8; direction += 1) {
        const angle = (direction / 8) * Math.PI * 2;
        const next = { x: spot.x + Math.cos(angle) * step, y: spot.y + Math.sin(angle) * step };
        const value = measure(next);
        if (value.cost < current.cost - 1e-9) {
          spot = next;
          current = value;
          moved = true;
        }
      }
      if (!moved) step /= 2;
    }
    if (current.overlap === 0 && (!best || current.bulge < best.bulge))
      best = { spot, bulge: current.bulge };
  }
  return best;
}

/**
 * Where a tool drawn between groups sits: the free spot nearest the middle of
 * the groups it serves, outside every blob by `WIDE_CLEAR` and clear of the
 * tools already set.
 */
export function betweenSpot(
  tool: { r: number },
  members: readonly Point[],
  blobs: readonly Blob[],
  taken: readonly Placed[],
): Point {
  const centre = {
    x: members.reduce((sum, group) => sum + group.x, 0) / Math.max(1, members.length),
    y: members.reduce((sum, group) => sum + group.y, 0) / Math.max(1, members.length),
  };
  const free = (spot: Point) =>
    blobs.every((blob) => !intrudes({ ...spot, r: tool.r }, blob, WIDE_CLEAR)) &&
    taken.every(
      (mark) => Math.hypot(spot.x - mark.x, spot.y - mark.y) >= mark.r + tool.r + TOOL_GAP,
    );
  for (let radius = 0; radius <= BETWEEN_SEARCH.reach; radius += BETWEEN_SEARCH.step) {
    const steps =
      radius === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * radius) / BETWEEN_SEARCH.step));
    for (let step = 0; step < steps; step += 1) {
      // Start each ring at the top and go round both ways, so the search reads the same everywhere.
      const angle =
        -Math.PI / 2 + (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2) * ((Math.PI * 2) / steps);
      const spot = {
        x: centre.x + Math.cos(angle) * radius,
        y: centre.y + Math.sin(angle) * radius,
      };
      if (free(spot)) return spot;
    }
  }
  return centre;
}

/**
 * Spots for the tools a group alone holds, heaviest first, each as near the
 * bottom of its ring as it can be while `free` and comfortably clear of the
 * ones already set, so a group's tools hang together along its lower edge.
 * `rings` are tried in order: the group's own ring first, then wider ones,
 * starting from the angle the packing made room at (`prefer`), where its blob
 * bulges to hold a tool its partners have left no room for on the ring. A tool
 * with no free spot anywhere takes the nearest spot on the ring that only
 * clears the others.
 */
export function placeOnRing(
  centre: Point,
  rings: readonly number[],
  tools: ReadonlyArray<{ id: string; r: number; prefer?: number }>,
  free: (spot: Placed) => boolean,
  /** The group's tools already in place, which these keep apart from too. */
  fixed: readonly Placed[] = [],
): Map<string, Point> {
  const set: Placed[] = [...fixed];
  const out = new Map<string, Point>();
  const offsets = Array.from(
    { length: RING_STEPS },
    (_, index) => (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * ((Math.PI * 2) / RING_STEPS),
  );
  const spotAt = (ring: number, angle: number, r: number): Placed => ({
    x: centre.x + Math.cos(angle) * ring,
    y: centre.y + Math.sin(angle) * ring,
    r,
  });
  const apart = (spot: Placed, factor: number) =>
    set.every(
      (other) =>
        Math.hypot(other.x - spot.x, other.y - spot.y) >= (other.r + spot.r + TOOL_GAP) * factor,
    );
  for (const tool of tools) {
    const choose = (ring: number, from: number, accept: (spot: Placed) => boolean) => {
      for (const offset of offsets) {
        const spot = spotAt(ring, wrapAngle(from + offset), tool.r);
        if (accept(spot)) return spot;
      }
      return null;
    };
    // On the ring, as near the bottom as it can be; past it, where the packing made room.
    const room = tool.prefer ?? RING_PREFER;
    let spot =
      choose(
        rings[0]!,
        RING_PREFER,
        (candidate) => apart(candidate, RING_COMFORT) && free(candidate),
      ) ?? choose(rings[0]!, RING_PREFER, (candidate) => apart(candidate, 1) && free(candidate));
    for (const ring of rings.slice(1))
      spot ??= choose(ring, room, (candidate) => apart(candidate, 1) && free(candidate));
    spot ??=
      choose(rings[0]!, room, (candidate) => apart(candidate, 1)) ??
      spotAt(rings[0]!, room, tool.r);
    set.push(spot);
    out.set(tool.id, { x: spot.x, y: spot.y });
  }
  return out;
}

/** Where a warning mark sits: the first spot on the outline, top right first, clear of its tools and of other blobs. */
export function badgeSpot(blob: Blob, tools: readonly Placed[], others: readonly Blob[]): Point {
  for (const angle of BADGE_ANGLES) {
    const spot = blobPointAt(blob, angle);
    const nearTool = tools.some(
      (tool) => Math.hypot(tool.x - spot.x, tool.y - spot.y) < tool.r + BADGE_CLEAR,
    );
    const inOther = others.some((other) => signedDistance(spot, other.points) > -4);
    if (!nearTool && !inOther) return spot;
  }
  return blobPointAt(blob, BADGE_ANGLES[0]!);
}

function boundsOfAll(boxes: readonly Bounds[], fallback: Bounds): Bounds {
  if (boxes.length === 0) return fallback;
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
  };
}

/**
 * The drawing from packed groups (`tools` busiest first):
 * 1. a tool two or three groups share takes the middle of where their rings
 *    overlap; one whose groups lie too far apart to hold it without
 *    stretching (`STRETCH_ALLOW`) is drawn between them instead;
 * 2. blobs are drawn around each group's body and the shared tools it holds;
 * 3. a tool shared widely, or one that could not be held, takes the free spot
 *    nearest the middle of its groups, outside every blob;
 * 4. each group's own tools are set on its ring, clear of every other blob
 *    (a little further out, its blob bulging, where its partners leave no
 *    room on the ring);
 * 5. each group gets its name's room and its warning mark's spot.
 */
export function placeMap(
  groupSpots: readonly GroupSpot[],
  tools: readonly ToolSpot[],
  space: { width: number; height: number },
): MapLayout {
  const heldBy = heldTools(tools);
  const groups: PackedGroup[] = groupSpots.map((group) => ({
    ...group,
    rings: groupRings(
      group.r,
      (heldBy.get(group.id) ?? []).map((tool) => tool.r),
    ),
  }));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const at = new Map<string, Point>();
  const placement = new Map<string, Placement>();
  const taken = (): Placed[] =>
    tools.filter((tool) => at.has(tool.id)).map((tool) => ({ ...at.get(tool.id)!, r: tool.r }));

  // 1. Shared tools in the overlap of their groups.
  for (const tool of tools) {
    if (tool.membership !== "shared") continue;
    const members = tool.groups.map((id) => groupById.get(id)!);
    const others = groups.filter((group) => !tool.groups.includes(group.id));
    const meeting = meetingSpot(tool, members, others, taken());
    const allowed = Math.min(...members.map((group) => group.rings.body * STRETCH_ALLOW));
    if (meeting && meeting.bulge <= allowed) {
      at.set(tool.id, meeting.spot);
      placement.set(tool.id, "overlap");
    } else {
      placement.set(tool.id, "between");
    }
  }

  // 2. Blobs around each body and the shared tools it holds; a group's own tools sit inside its body.
  const blobs = new Map<string, Blob>();
  for (const group of groups) {
    const shared = (heldBy.get(group.id) ?? [])
      .filter((tool) => placement.get(tool.id) === "overlap")
      .map((tool) => ({ ...at.get(tool.id)!, r: tool.r }));
    blobs.set(group.id, blobOutline(group.id, group, heldDiscs(group, group.rings, shared)));
  }
  const allBlobs = [...blobs.values()];

  // 3. Widely shared tools, and shared ones that could not be held, between their groups.
  for (const tool of tools) {
    if (tool.membership === "single" || placement.get(tool.id) === "overlap") continue;
    placement.set(tool.id, "between");
    at.set(
      tool.id,
      betweenSpot(
        tool,
        tool.groups.map((id) => groupById.get(id)!),
        allBlobs,
        taken(),
      ),
    );
  }

  // 4. Each group's own tools on its ring, clear of every other blob and of the tools around it;
  // where its partners leave no room on the ring, a little further out, and its blob bulges to hold them.
  const loose = taken();
  /** Sets `own` on the group's rings, keeping apart from `fixed`; with `onlyIfFree`, a tool is moved only to a free spot. */
  const placeOwn = (
    group: PackedGroup,
    own: readonly ToolSpot[],
    fixed: readonly Placed[],
    onlyIfFree = false,
  ) => {
    const reach = group.rings.reach * 1.5;
    const near = {
      minX: group.x - reach,
      minY: group.y - reach,
      maxX: group.x + reach,
      maxY: group.y + reach,
    };
    const others = groups
      .filter((other) => other.id !== group.id && boundsMeet(blobs.get(other.id)!.bounds, near))
      .map((other) => blobs.get(other.id)!);
    const marks = loose.filter(
      (mark) => Math.hypot(mark.x - group.x, mark.y - group.y) < reach + mark.r,
    );
    const free = (spot: Placed) => {
      // Past the ring, the bulge keeps a little more room from everyone else.
      const clear =
        Math.hypot(spot.x - group.x, spot.y - group.y) > group.rings.ring + 0.5
          ? TOOL_PAD + BULGE_CLEAR
          : TOOL_PAD;
      return (
        others.every((blob) => !intrudes(spot, blob, clear)) &&
        marks.every(
          (mark) => Math.hypot(mark.x - spot.x, mark.y - spot.y) >= mark.r + spot.r + TOOL_GAP,
        )
      );
    };
    const step = Math.max(...own.map((tool) => tool.r)) * 2 + TOOL_GAP;
    const rings = [
      group.rings.ring,
      ...Array.from({ length: BULGE_RINGS }, (_, index) => group.rings.ring + step * (index + 1)),
    ];
    // Each tool starts from where the packing made room for it, the bottom of the ring when it is free.
    const preferring = own.map((tool) => ({
      ...tool,
      prefer: tool.hint ? Math.atan2(tool.hint.y - group.y, tool.hint.x - group.x) : RING_PREFER,
    }));
    const spots = placeOnRing(group, rings, preferring, free, fixed);
    for (const tool of own) {
      const spot = spots.get(tool.id)!;
      if (onlyIfFree && !free({ ...spot, r: tool.r })) continue;
      at.set(tool.id, spot);
      placement.set(tool.id, "inside");
    }
    // A blob is redrawn round any of its own tools that sit past its body.
    const held = (heldBy.get(group.id) ?? []).filter(
      (tool) => placement.get(tool.id) !== "between",
    );
    if (
      held.some(
        (tool) =>
          at.has(tool.id) &&
          Math.hypot(at.get(tool.id)!.x - group.x, at.get(tool.id)!.y - group.y) +
            tool.r +
            TOOL_PAD >
            group.rings.body,
      )
    ) {
      blobs.set(
        group.id,
        blobOutline(
          group.id,
          group,
          heldDiscs(
            group,
            group.rings,
            held
              .filter((tool) => at.has(tool.id))
              .map((tool) => ({ ...at.get(tool.id)!, r: tool.r })),
          ),
        ),
      );
    }
  };
  const ownOf = (group: PackedGroup) =>
    (heldBy.get(group.id) ?? [])
      .filter((tool) => tool.membership === "single")
      .sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : 1));
  for (const group of groups) {
    const own = ownOf(group);
    if (own.length > 0) placeOwn(group, own, []);
  }
  // A blob that bulged may now crowd a neighbour's tool: that tool finds a new spot, once or twice.
  for (let round = 0; round < 2; round += 1) {
    let moved = false;
    for (const group of groups) {
      for (const tool of ownOf(group)) {
        const spot = { ...at.get(tool.id)!, r: tool.r };
        const crowded = groups.some(
          (other) => other.id !== group.id && intrudes(spot, blobs.get(other.id)!, TOOL_PAD),
        );
        if (!crowded) continue;
        const rest = ownOf(group)
          .filter((other) => other !== tool)
          .map((other) => ({ ...at.get(other.id)!, r: other.r }));
        placeOwn(group, [tool], rest, true);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // 5. Names and warning marks.
  const layoutGroups = new Map<string, LayoutGroup>();
  for (const group of groups) {
    const blob = blobs.get(group.id)!;
    const held = (heldBy.get(group.id) ?? [])
      .filter((tool) => placement.get(tool.id) !== "between")
      .map((tool) => ({ ...at.get(tool.id)!, r: tool.r }));
    const others = groups
      .filter(
        (other) => other.id !== group.id && boundsMeet(blob.bounds, blobs.get(other.id)!.bounds),
      )
      .map((other) => blobs.get(other.id)!);
    layoutGroups.set(group.id, {
      ask: group.id,
      x: group.x,
      y: group.y,
      r: group.r,
      blob,
      name: nameCircle(
        blob,
        held.map((tool) => ({ ...tool, r: tool.r + NAME_TOOL_CLEAR })),
        others,
      ),
      nameSize: nameSize(group.r, CORE_RADIUS),
      badge: badgeSpot(blob, held, others),
    });
  }

  const nodes = new Map<string, LayoutNode>();
  for (const tool of tools) {
    const spot = at.get(tool.id)!;
    const home = tool.membership === "single" ? groupById.get(tool.groups[0]!) : undefined;
    nodes.set(tool.id, {
      id: tool.id,
      kind: tool.kind,
      x: spot.x,
      y: spot.y,
      r: tool.r,
      membership: tool.membership,
      placement: placement.get(tool.id)!,
      groups: tool.groups,
      angle: home ? Math.atan2(spot.y - home.y, spot.x - home.x) : null,
    });
  }

  const bounds = boundsOfAll(
    [
      ...[...blobs.values()].map((blob) => blob.bounds),
      ...[...nodes.values()].map((node) => ({
        minX: node.x - node.r,
        minY: node.y - node.r,
        maxX: node.x + node.r,
        maxY: node.y + node.r,
      })),
    ],
    { minX: 0, minY: 0, maxX: space.width, maxY: space.height },
  );
  return { groups: layoutGroups, nodes, width: space.width, height: space.height, bounds };
}
