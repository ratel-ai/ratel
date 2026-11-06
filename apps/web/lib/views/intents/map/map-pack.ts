/**
 * Where the intent map's groups sit: packed so that the groups sharing a tool
 * meet around it, and groups sharing nothing keep apart.
 *
 * First a greedy start that follows the shared tools: the group with the most
 * shared calls goes in the middle; each next one is the group most tied to
 * those already placed, set beside them with rings touching, on the side that
 * crowds the rest least. Groups that share nothing take the free spot nearest
 * the middle. Then rounds of relaxing, with every tool a group holds standing
 * in as a point of its own: each group keeps its tools' points in its band
 * (off its core, inside its body), every pair of things keeps its distance (so
 * a group's own tools push the groups it shares with aside until they have
 * room), and the drawing is drawn gently toward the middle in the view's
 * shape. Pure and deterministic: the same groups always pack the same way.
 */
import type { Point } from "@/lib/views/intents/map/map-geometry";
import { RING_GAP, TOOL_GAP, TOOL_PAD } from "@/lib/views/intents/map/map-membership";

export interface PackGroup {
  id: string;
  /** The core's radius. */
  core: number;
  /** The ring its own tools sit on. */
  ring: number;
  /** Its round body: what its blob is drawn around. */
  body: number;
  /** How far its blob can reach. */
  reach: number;
}

/** A tool the groups hold: one group's own, or one two or three groups share. */
export interface PackTool {
  id: string;
  r: number;
  /** Its calls, which weigh how hard its groups are drawn together. */
  weight: number;
  groups: readonly string[];
}

export interface Packing {
  groups: Map<string, Point>;
  /** Where each tool's point settled: on its group's ring, or where its groups meet. */
  tools: Map<string, Point>;
}

/** Candidate directions around a placed group. */
const DIRECTIONS = 24;
/** The most placed partners a group is set beside directly. */
const PARTNERS_TRIED = 3;
/** Rounds of relaxing after the greedy start; the last ones only part what overlaps. */
const ROUNDS = 160;
const PARTING_ROUNDS = 40;
/** How hard the drawing is drawn toward the middle each round, at first. */
const PULL = 0.02;
/** Groups sharing a tool sit no closer than this share of their rings' reach, so their own tools keep room. */
const PARTNER_NEAR = 0.9;
/** A shared tool may sit this far past where its groups' bodies hold it as they are; the blob bulges a little. */
const BAND_SLACK = 2;

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Where two circles cross: none, or two points. */
function crossings(a: Point, ra: number, b: Point, rb: number): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0 || distance > ra + rb || distance < Math.abs(ra - rb)) return [];
  const along = (ra * ra - rb * rb + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, ra * ra - along * along));
  const mx = a.x + (dx * along) / distance;
  const my = a.y + (dy * along) / distance;
  return [
    { x: mx - (dy * height) / distance, y: my + (dx * height) / distance },
    { x: mx + (dy * height) / distance, y: my - (dx * height) / distance },
  ];
}

/** How far a tool's point may sit from a group that holds it: off its core, inside its body. */
export function bandRange(group: PackGroup, tool: { r: number }): { min: number; max: number } {
  const min = group.core + RING_GAP + tool.r;
  return { min, max: Math.max(min, group.body - tool.r - TOOL_PAD + BAND_SLACK) };
}

type Pairs = {
  /** The calls each pair of groups shares through tools both hold, and whether one of those tools has a third group. */
  weight: Map<string, number>;
  triple: Set<string>;
};

function pairsOf(tools: readonly PackTool[]): Pairs {
  const weight = new Map<string, number>();
  const triple = new Set<string>();
  for (const tool of tools) {
    for (let i = 0; i < tool.groups.length; i += 1) {
      for (let j = i + 1; j < tool.groups.length; j += 1) {
        const pair = key(tool.groups[i]!, tool.groups[j]!);
        weight.set(pair, (weight.get(pair) ?? 0) + Math.max(tool.weight, 1e-9));
        if (tool.groups.length > 2) triple.add(pair);
      }
    }
  }
  return { weight, triple };
}

/**
 * How close two groups may come and how far apart they may drift. Groups
 * sharing a tool meet around it: their rings reach each other, and they come
 * no closer than a little inside that, so the overlap stays a lens and each
 * keeps most of its ring for its own tools (three such groups still meet round
 * one spot). Groups sharing nothing keep `gap` between their blobs.
 */
export function groupRange(
  a: PackGroup,
  b: PackGroup,
  pairs: Pairs,
  gap: number,
): { min: number; max: number } {
  if (!pairs.weight.has(key(a.id, b.id))) return { min: a.reach + b.reach + gap, max: Infinity };
  const max = a.ring + b.ring + BAND_SLACK * 2;
  return {
    min: Math.min(max, Math.max(a.core + b.core + RING_GAP * 2, (a.ring + b.ring) * PARTNER_NEAR)),
    max,
  };
}

/** The greedy start: each group beside the placed groups it shares tools with, or in the free spot nearest the middle. */
function seed(
  groups: readonly PackGroup[],
  pairs: Pairs,
  centre: Point,
  gap: number,
  stretch: number,
): Float64Array[] {
  const count = groups.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const mins = new Float64Array(count * count);
  const maxs = new Float64Array(count * count);
  const weights = new Float64Array(count * count);
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      if (i === j) continue;
      const range = groupRange(groups[i]!, groups[j]!, pairs, gap);
      mins[i * count + j] = range.min;
      // A three-way partner is aimed a little inside its ring, so the three can meet.
      maxs[i * count + j] = pairs.triple.has(key(groups[i]!.id, groups[j]!.id))
        ? (groups[i]!.ring + groups[j]!.ring) * PARTNER_NEAR
        : range.max;
      weights[i * count + j] = pairs.weight.get(key(groups[i]!.id, groups[j]!.id)) ?? 0;
    }
  }
  const maxWeight = weights.reduce((most, value) => Math.max(most, value), 1e-9);
  const isPlaced = new Uint8Array(count);
  const placed: number[] = [];
  const cost = (index: number, x: number, y: number) => {
    // Nearer the middle is better, measured in the view's shape.
    const cx = (x - centre.x) / stretch;
    const cy = (y - centre.y) * stretch;
    let value = Math.sqrt(cx * cx + cy * cy) * 0.01;
    for (const other of placed) {
      const dx = x - xs[other]!;
      const dy = y - ys[other]!;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const at = index * count + other;
      if (distance < mins[at]!) value += 50 * (mins[at]! - distance);
      if (distance > maxs[at]!) value += 5 * (weights[at]! / maxWeight) * (distance - maxs[at]!);
    }
    return value;
  };
  const tie = (index: number) =>
    placed.reduce((sum, other) => sum + weights[index * count + other]!, 0);
  const total = (index: number) =>
    weights.subarray(index * count, index * count + count).reduce((sum, value) => sum + value, 0);

  while (placed.length < count) {
    // The unplaced group most tied to the placed ones; else the most tied of all, busiest first.
    let next = -1;
    let nextTie = 0;
    for (let index = 0; index < count; index += 1) {
      if (isPlaced[index]) continue;
      const value = tie(index);
      if (value > nextTie) {
        next = index;
        nextTie = value;
      }
    }
    if (next < 0) {
      for (let index = 0; index < count; index += 1) {
        if (!isPlaced[index] && (next < 0 || total(index) > total(next))) next = index;
      }
    }
    let spot: Point = { ...centre };
    if (placed.length > 0) {
      const near = placed
        .filter((other) => weights[next * count + other]! > 0)
        .sort((a, b) => weights[next * count + b]! - weights[next * count + a]! || a - b)
        .slice(0, PARTNERS_TRIED);
      const candidates: Point[] = [];
      const around = (other: number, distance: number) => {
        for (let step = 0; step < DIRECTIONS; step += 1) {
          const angle = (step / DIRECTIONS) * Math.PI * 2;
          candidates.push({
            x: xs[other]! + Math.cos(angle) * distance,
            y: ys[other]! + Math.sin(angle) * distance,
          });
        }
      };
      if (near.length > 0) {
        for (const other of near) around(other, maxs[next * count + other]!);
        for (let i = 0; i < near.length; i += 1) {
          for (let j = i + 1; j < near.length; j += 1) {
            const a = near[i]!;
            const b = near[j]!;
            candidates.push(
              ...crossings(
                { x: xs[a]!, y: ys[a]! },
                maxs[next * count + a]!,
                { x: xs[b]!, y: ys[b]! },
                maxs[next * count + b]!,
              ),
            );
          }
        }
      } else {
        for (const other of placed) around(other, mins[next * count + other]!);
      }
      let best = Infinity;
      for (const candidate of candidates) {
        const value = cost(next, candidate.x, candidate.y);
        if (value < best) {
          best = value;
          spot = candidate;
        }
      }
    }
    xs[next] = spot.x;
    ys[next] = spot.y;
    isPlaced[next] = 1;
    placed.push(next);
  }
  return [xs, ys];
}

/**
 * The packing: the greedy start, then rounds of moving every pair that is out
 * of its range halfway back into it (the larger yielding less), with each held
 * tool's point among them, while the groups are drawn toward the middle (less
 * each round, more across the view's short side).
 */
export function packMap(
  groups: readonly PackGroup[],
  tools: readonly PackTool[],
  centre: Point,
  gap: number,
  aspect = 1,
): Packing {
  const pairs = pairsOf(tools);
  const stretch = aspect ** 0.75;
  const [groupXs, groupYs] = seed(groups, pairs, centre, gap, stretch) as [
    Float64Array,
    Float64Array,
  ];
  const index = new Map(groups.map((group, at) => [group.id, at]));
  const count = groups.length + tools.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const mass = new Float64Array(count);
  groups.forEach((group, at) => {
    xs[at] = groupXs[at]!;
    ys[at] = groupYs[at]!;
    mass[at] = group.core * group.core;
  });
  // A group's own tools start along the bottom of its ring, the rest where their groups meet.
  const ownCount = new Map<string, number>();
  tools.forEach((tool, at) => {
    const members = tool.groups.map((id) => index.get(id)!);
    if (members.length === 1) {
      const group = groups[members[0]!]!;
      const order = ownCount.get(group.id) ?? 0;
      ownCount.set(group.id, order + 1);
      const angle = Math.PI / 2 + (order % 2 === 1 ? 1 : -1) * Math.ceil(order / 2) * 0.5;
      xs[groups.length + at] = groupXs[members[0]!]! + Math.cos(angle) * group.ring;
      ys[groups.length + at] = groupYs[members[0]!]! + Math.sin(angle) * group.ring;
    } else {
      xs[groups.length + at] =
        members.reduce((sum, member) => sum + groupXs[member]!, 0) / members.length;
      ys[groups.length + at] =
        members.reduce((sum, member) => sum + groupYs[member]!, 0) / members.length;
    }
    mass[groups.length + at] = tool.r * tool.r;
  });

  const mins = new Float64Array(count * count);
  const maxs = new Float64Array(count * count);
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      let range = { min: 0, max: Infinity };
      if (j < groups.length) {
        range = groupRange(groups[i]!, groups[j]!, pairs, gap);
      } else if (i < groups.length) {
        const group = groups[i]!;
        const tool = tools[j - groups.length]!;
        range = tool.groups.includes(group.id)
          ? bandRange(group, tool)
          : { min: group.reach + tool.r + TOOL_PAD + gap / 2, max: Infinity };
      } else {
        range = {
          min: tools[i - groups.length]!.r + tools[j - groups.length]!.r + TOOL_GAP,
          max: Infinity,
        };
      }
      mins[i * count + j] = range.min;
      maxs[i * count + j] = range.max;
    }
  }

  for (let round = 0; round < ROUNDS + PARTING_ROUNDS; round += 1) {
    // In the last rounds only overlaps are undone: where a cluster asks for more than fits, nothing ends up on top of anything.
    const parting = round >= ROUNDS;
    const pull = parting ? 0 : PULL * (1 - round / ROUNDS);
    for (let at = 0; at < groups.length; at += 1) {
      xs[at] = xs[at]! + (centre.x - xs[at]!) * (pull / stretch);
      ys[at] = ys[at]! + (centre.y - ys[at]!) * (pull * stretch);
    }
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = xs[j]! - xs[i]!;
        let dy = ys[j]! - ys[i]!;
        let distance = Math.sqrt(dx * dx + dy * dy);
        const min = mins[i * count + j]!;
        const max = parting ? Infinity : maxs[i * count + j]!;
        if (distance >= min && distance <= max) continue;
        if (distance === 0) {
          // Two on one spot part in a direction fixed by their order, so the packing repeats.
          distance = 1e-6;
          dx = Math.cos(i + j) * distance;
          dy = Math.sin(i + j) * distance;
        }
        const target = distance < min ? min : max;
        const move = ((distance - target) / distance) * 0.5;
        const share = mass[j]! / (mass[i]! + mass[j]!);
        xs[i] = xs[i]! + dx * move * share;
        ys[i] = ys[i]! + dy * move * share;
        xs[j] = xs[j]! - dx * move * (1 - share);
        ys[j] = ys[j]! - dy * move * (1 - share);
      }
    }
  }
  return {
    groups: new Map(groups.map((group, at) => [group.id, { x: xs[at]!, y: ys[at]! }])),
    tools: new Map(
      tools.map((tool, at) => [
        tool.id,
        { x: xs[groups.length + at]!, y: ys[groups.length + at]! },
      ]),
    ),
  };
}
