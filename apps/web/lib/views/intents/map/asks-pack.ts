import type { hierarchy as d3Hierarchy, pack as d3Pack } from "d3-hierarchy";
import type { AsksTreeWay, IntentAsksTree } from "@/lib/views/intents/asks-tree";
import type { Bounds } from "@/lib/views/intents/map/map-geometry";

/**
 * The Asks lens of Intents › Map, laid out (DESIGN.md, Data visualization):
 * every intent a circle as large as its asks, and inside it what they ask
 * for, and inside each of those the ways people ask it, each as large as its
 * share. Two passes, so nothing moves when the inner levels arrive (they are
 * read after the page): the intents are packed on their own asks first, then
 * each intent's tree is packed inside its circle. A level with one child is
 * skipped (an intent that is one thing holds its ways directly; a thing asked
 * one way holds nothing), and what was not listed is one rest circle, so the
 * sizes stay true to the whole. Pure and deterministic: ids, keys and
 * numbers; the labels are the caller's to look up. `d3-hierarchy` comes in
 * as an argument, so the page loads it only when the lens opens.
 */

/** The two `d3-hierarchy` functions the layout packs with. */
export interface PackKit {
  hierarchy: typeof d3Hierarchy;
  pack: typeof d3Pack;
}

export type AsksNodeKind = "intent" | "group" | "way" | "rest";

export interface AsksNode {
  /** Unique in the layout: `i:<topic>`, `g:<topic>:<group>`, `w:<topic>:<group>:<way>`, or `r:<parent key>`. */
  key: string;
  kind: AsksNodeKind;
  /** 1 for an intent, 2 inside it, 3 inside that. */
  depth: 1 | 2 | 3;
  /** The key of the circle it sits in; the root (`ROOT`) for an intent. */
  parent: string;
  /** The intent it belongs to. */
  intent: string;
  /** The group it belongs to, when it is one or sits in one. */
  group: string | null;
  /** A way's id, for a way. */
  way: string | null;
  /** Centre and radius, in map units. */
  x: number;
  y: number;
  r: number;
  asks: number;
  /** The asks its circles share, as read: the total their "N of M" and shares are of (0 for a leaf). */
  of: number;
  /** For a rest: how many things or ways it stands for. */
  count: number;
}

export interface AsksLayout {
  /** Busiest intent first, each followed by everything inside it, parents before children. */
  nodes: AsksNode[];
  byKey: ReadonlyMap<string, AsksNode>;
  /** Each key's children, busiest first; `ROOT` holds the intents. */
  children: ReadonlyMap<string, string[]>;
  /** Around every intent (map units). */
  bounds: Bounds;
}

/** The square the intents are packed into (map units); the view fits it. */
export const ASKS_SPACE = 1000;
/** Room between two intents (map units). */
const INTENT_GAP = 16;
/** Room inside an intent's edge, as a share of its radius, so its blob's wobble never cuts a circle inside. */
const INTENT_INSET = 0.08;

export const ROOT = "";
export const intentKey = (topicId: string) => `i:${topicId}`;
export const groupKey = (topicId: string, groupId: string) => `g:${topicId}:${groupId}`;
export const wayKey = (topicId: string, groupId: string, wayId: string) =>
  `w:${topicId}:${groupId}:${wayId}`;
const restKey = (parent: string) => `r:${parent}`;

interface Leaf {
  key: string;
  kind: AsksNodeKind;
  group: string | null;
  way: string | null;
  asks: number;
  count: number;
}

function rest(parent: string, group: string | null, asks: number, count: number): Leaf[] {
  return asks > 0 && count > 0
    ? [{ key: restKey(parent), kind: "rest", group, way: null, asks, count }]
    : [];
}

function waysOf(topicId: string, groupId: string, ways: readonly AsksTreeWay[]): Leaf[] {
  return ways.map((way) => ({
    key: wayKey(topicId, groupId, way.id),
    kind: "way",
    group: groupId,
    way: way.id,
    asks: way.asks,
    count: 0,
  }));
}

/** What an intent holds, by the skipping rule: its things (and a rest), or with one thing that thing's ways. */
function intentLeaves(tree: IntentAsksTree): Leaf[] {
  const topicId = tree.topicId;
  const own = intentKey(topicId);
  const [only] = tree.groups;
  if (tree.skipped && only) {
    return only.ways.length === 0
      ? []
      : [
          ...waysOf(topicId, only.id, only.ways),
          ...rest(own, only.id, only.restAsks, only.restWays),
        ];
  }
  return [
    ...tree.groups.map(
      (group): Leaf => ({
        key: groupKey(topicId, group.id),
        kind: "group",
        group: group.id,
        way: null,
        asks: group.asks,
        count: 0,
      }),
    ),
    ...rest(own, null, tree.restAsks, tree.restGroups),
  ];
}

const byAsks = (
  a: { value?: number; data: { key: string } },
  b: { value?: number; data: { key: string } },
) =>
  (b.value ?? 0) - (a.value ?? 0) ||
  (a.data.key < b.data.key ? -1 : a.data.key > b.data.key ? 1 : 0);

/**
 * Siblings as leaves in a circle at (`cx`, `cy`, `r`): each as large as its
 * asks among the others, whatever it holds itself, with `gap` (a share of
 * `r`) between them and the edge.
 */
function packLeaves(
  kit: PackKit,
  leaves: readonly Leaf[],
  circle: { x: number; y: number; r: number },
  gap: number,
): Array<{ leaf: Leaf; x: number; y: number; r: number }> {
  const root = kit
    .hierarchy<Leaf | { key: string; kind: "root"; children: Leaf[] }>(
      { key: "", kind: "root", children: [...leaves] },
      (datum) => ("children" in datum ? datum.children : undefined),
    )
    .sum((datum) => ("children" in datum ? 0 : datum.asks))
    .sort(byAsks);
  kit
    .pack<Leaf | { key: string; kind: "root"; children: Leaf[] }>()
    .size([2 * circle.r, 2 * circle.r])
    .padding(circle.r * gap)(root);
  return (root.children ?? []).map((child) => {
    const placed = child as unknown as { x: number; y: number; r: number };
    return {
      leaf: child.data as Leaf,
      x: circle.x - circle.r + placed.x,
      y: circle.y - circle.r + placed.y,
      r: placed.r,
    };
  });
}

/** Room between the things inside an intent, and between the ways inside a thing, as a share of the circle holding them. */
const INTENT_GAP_SHARE = 0.035;
const GROUP_GAP_SHARE = 0.05;

export function layoutAsks(
  intents: ReadonlyArray<{ id: string; asks: number }>,
  trees: ReadonlyMap<string, IntentAsksTree>,
  kit: PackKit,
): AsksLayout {
  const shown = intents.filter((intent) => intent.asks > 0);
  const nodes: AsksNode[] = [];
  const byKey = new Map<string, AsksNode>();
  const children = new Map<string, string[]>([[ROOT, []]]);
  const add = (node: AsksNode) => {
    nodes.push(node);
    byKey.set(node.key, node);
    children.get(node.parent)?.push(node.key);
    children.set(node.key, []);
  };
  if (shown.length === 0)
    return { nodes, byKey, children, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };

  // 1. The intents, on their own asks.
  const top = packLeaves(
    kit,
    shown.map((intent) => ({
      key: intentKey(intent.id),
      kind: "intent",
      group: null,
      way: null,
      asks: intent.asks,
      count: 0,
    })),
    { x: ASKS_SPACE / 2, y: ASKS_SPACE / 2, r: ASKS_SPACE / 2 },
    INTENT_GAP / (ASKS_SPACE / 2),
  );
  for (const { leaf, x, y, r } of top) {
    const topicId = leaf.key.slice(2);
    const tree = trees.get(topicId);
    const inner = tree ? intentLeaves(tree) : [];
    add({
      key: leaf.key,
      kind: "intent",
      depth: 1,
      parent: ROOT,
      intent: topicId,
      group: null,
      way: null,
      x,
      y,
      r,
      asks: leaf.asks,
      of: inner.reduce((total, item) => total + item.asks, 0),
      count: 0,
    });
    if (!tree || inner.length === 0) continue;

    // 2. What it holds, each as large as its share, whatever it holds in turn.
    for (const placed of packLeaves(
      kit,
      inner,
      { x, y, r: r * (1 - INTENT_INSET) },
      INTENT_GAP_SHARE,
    )) {
      const group =
        placed.leaf.kind === "group"
          ? tree.groups.find((item) => item.id === placed.leaf.group)
          : undefined;
      const ways =
        group && group.ways.length > 0
          ? [
              ...waysOf(topicId, group.id, group.ways),
              ...rest(placed.leaf.key, group.id, group.restAsks, group.restWays),
            ]
          : [];
      add({
        key: placed.leaf.key,
        kind: placed.leaf.kind,
        depth: 2,
        parent: leaf.key,
        intent: topicId,
        group: placed.leaf.group,
        way: placed.leaf.way,
        x: placed.x,
        y: placed.y,
        r: placed.r,
        asks: placed.leaf.asks,
        of: ways.reduce((total, item) => total + item.asks, 0),
        count: placed.leaf.count,
      });

      // 3. The ways people ask it, inside it.
      for (const way of ways.length > 0 ? packLeaves(kit, ways, placed, GROUP_GAP_SHARE) : []) {
        add({
          key: way.leaf.key,
          kind: way.leaf.kind,
          depth: 3,
          parent: placed.leaf.key,
          intent: topicId,
          group: way.leaf.group,
          way: way.leaf.way,
          x: way.x,
          y: way.y,
          r: way.r,
          asks: way.leaf.asks,
          of: 0,
          count: way.leaf.count,
        });
      }
    }
  }

  const tops = (children.get(ROOT) ?? []).map((key) => byKey.get(key)!);
  return {
    nodes,
    byKey,
    children,
    bounds: {
      minX: Math.min(...tops.map((node) => node.x - node.r)),
      minY: Math.min(...tops.map((node) => node.y - node.r)),
      maxX: Math.max(...tops.map((node) => node.x + node.r)),
      maxY: Math.max(...tops.map((node) => node.y + node.r)),
    },
  };
}

/** The keys from an intent down to `key`, the intent first; empty for the root or an unknown key. */
export function pathTo(layout: Pick<AsksLayout, "byKey">, key: string): string[] {
  const path: string[] = [];
  for (let node = layout.byKey.get(key); node; node = layout.byKey.get(node.parent))
    path.unshift(node.key);
  return path;
}

/**
 * Where a click lands: one level below the focus, on the way to what was hit
 * (so the reader goes in one level at a time); the focus itself when what was
 * hit is not inside it, or is a leaf already in view.
 */
export function stepToward(layout: Pick<AsksLayout, "byKey">, focus: string, hit: string): string {
  const path = pathTo(layout, hit);
  if (focus === ROOT) return path[0] ?? ROOT;
  const at = path.indexOf(focus);
  if (at < 0) return path[0] ?? ROOT;
  return path[at + 1] ?? focus;
}

/**
 * What a circle carries on screen: its name and count at its centre (`full`),
 * its name along its top inside edge while its own circles carry theirs
 * (`edge`), or, too small for a name, its count alone (`count`).
 */
export type AsksLabelMode = "full" | "edge" | "count";

/** Where a label goes on screen. */
export interface AsksLabelSpot {
  key: string;
  kind: AsksNodeKind;
  mode: AsksLabelMode;
  /** Screen pixels: the label's centre. */
  left: number;
  top: number;
  width: number;
  fontSize: number;
  /** Lines it may take before it is cut short. */
  lines: number;
}

/** From this radius on screen a circle carries its name; below it, down to `LABEL_COUNT_RADIUS`, its count. */
const LABEL_MIN_RADIUS: Record<AsksNodeKind, number> = { intent: 30, group: 34, way: 34, rest: 28 };
const LABEL_COUNT_RADIUS = 13;
/** From this radius on screen a circle's own circles carry their labels, and its name moves to its top edge. */
export const LABEL_OPEN_RADIUS = 150;
const LABEL_MAX_WIDTH = 240;

/**
 * The labels on screen at a focus and a view: semantic zoom, as the circles
 * grow. The circles one level in are labelled first (the intents at the
 * root); a circle grown past `LABEL_OPEN_RADIUS` hands its centre to its own
 * circles and keeps its name along its top edge; a circle too small for a
 * name shows its count. Screen units, for the label layer over the drawing.
 */
export function labelSpots(
  layout: Pick<AsksLayout, "byKey" | "children">,
  focus: string,
  t: { x: number; y: number; k: number },
): AsksLabelSpot[] {
  const spots: AsksLabelSpot[] = [];
  const place = (key: string) => {
    const node = layout.byKey.get(key);
    if (!node) return;
    const r = node.r * t.k;
    const left = node.x * t.k + t.x;
    const top = node.y * t.k + t.y;
    const inner = layout.children.get(key) ?? [];
    if (r >= LABEL_OPEN_RADIUS && inner.length > 0) {
      const fontSize = 13;
      spots.push({
        key,
        kind: node.kind,
        mode: "edge",
        left,
        top: top - r + Math.max(14, r * 0.07) + fontSize / 2,
        width: Math.min(LABEL_MAX_WIDTH, 1.4 * r),
        fontSize,
        lines: 1,
      });
      for (const child of inner) place(child);
      return;
    }
    if (r >= LABEL_MIN_RADIUS[node.kind]) {
      const largest = node.kind === "intent" ? 16 : 14;
      spots.push({
        key,
        kind: node.kind,
        mode: "full",
        left,
        top,
        width: Math.min(LABEL_MAX_WIDTH, 2 * r),
        fontSize: Math.round(Math.min(largest, Math.max(12, r / 5))),
        lines: node.kind === "way" ? 3 : 2,
      });
      return;
    }
    if (r >= LABEL_COUNT_RADIUS && node.kind !== "rest")
      spots.push({
        key,
        kind: node.kind,
        mode: "count",
        left,
        top,
        width: 2 * r,
        fontSize: 12,
        lines: 1,
      });
  };
  for (const key of layout.children.get(focus) ?? []) place(key);
  return spots;
}

/** How far into a circle a pinch goes before the lens steps into it: its radius against the view's shorter side. */
export const ENTER_SHARE = 0.42;

/**
 * The circle a zoom has gone into: one level in from the focus, under the
 * point, grown past `ENTER_SHARE` of the view, and holding circles of its
 * own (a leaf is read where it is). Null when none has.
 */
export function zoomedInto(
  layout: Pick<AsksLayout, "byKey" | "children">,
  focus: string,
  t: { x: number; y: number; k: number },
  point: { x: number; y: number },
  view: { width: number; height: number },
): string | null {
  const limit = ENTER_SHARE * Math.min(view.width, view.height);
  for (const key of layout.children.get(focus) ?? []) {
    const node = layout.byKey.get(key);
    if (!node || (layout.children.get(key)?.length ?? 0) === 0) continue;
    const r = node.r * t.k;
    const dx = node.x * t.k + t.x - point.x;
    const dy = node.y * t.k + t.y - point.y;
    if (r >= limit && dx * dx + dy * dy <= r * r) return key;
  }
  return null;
}

/** The circle a focus key names, or its intent's when the key is gone (a rebuild renamed it), or the root. */
export function resolveFocus(layout: Pick<AsksLayout, "byKey">, focus: string | null): string {
  if (!focus) return ROOT;
  const node = layout.byKey.get(focus);
  if (node && (node.kind === "intent" || node.kind === "group")) return focus;
  if (node) return node.parent;
  const topic = /^(?:r:)?[igw]:([^:]+)/.exec(focus)?.[1];
  return topic && layout.byKey.has(intentKey(topic)) ? intentKey(topic) : ROOT;
}
