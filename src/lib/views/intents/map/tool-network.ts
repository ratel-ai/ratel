/**
 * The tool network: which tools run together, drawn as a force-directed graph
 * on the Intents page (the Tools lens). Built from plain input:
 *
 * - the intent map's model, where two tools are linked when they answer the
 *   same intents (the link keeps the ids of the intents they share);
 * - optionally, the Tool Explorer's "came next" counts: how often one tool
 *   was the call right after another in the same turn (directed).
 *
 * Never a hairball. Every tool keeps its strongest few links (the backbone),
 * plus any link strong in its own right; the rest show only while one of
 * their tools is pointed at. Hubs (tools serving many ask groups, or linked to
 * many tools beyond their own groups') are flagged and left out of the
 * grouping, so they cannot glue unrelated groups together. Groups are the
 * connected components of the backbone without the hubs, joined strongest
 * link first and never past `MAX_GROUP_SIZE`. The three biggest wear the
 * three categorical hues that passed the color-blind check against the
 * canvas; every other group stays neutral.
 *
 * Pure and deterministic: the same input gives the same model, whatever order
 * it arrives in. Ids only: ask labels never enter it.
 */
import { wilsonInterval } from "@/lib/readings/stats";
import type { ExplorerEdge } from "@/lib/readings/tool-explorer/types";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";

/** The hues groups wear, biggest group first: validated together against the canvas. Never more. */
export const GROUP_COLORS = ["chart-1", "chart-5", "chart-4"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** Each tool keeps at least this many of its strongest links at rest. */
export const BACKBONE_K = 2;
/** A link at least this strong is kept at rest, whatever its tools' other links. */
export const STRENGTH_FLOOR = 0.3;
/** A tool serving this many ask groups is a hub. */
export const HUB_GROUPS = 4;
/** A tool linked to this many tools beyond the most any one of its ask groups gives it is a hub. */
export const HUB_EXTRA_PARTNERS = 5;
/** A group never grows past this many tools: links join it strongest first, so a bigger one splits at its weakest. */
export const MAX_GROUP_SIZE = 10;
/** A "came next" count below this is noise, left out. */
export const MIN_STEPS = 2;
/** One direction must be at least this many times the other for a link to read as one-way. */
export const ONE_WAY_RATIO = 2;

/** One "came next" count, in capability keys (`tool:<id>`, `skill:<id>`). */
export interface ToolStep {
  /** The call before. */
  from: string;
  /** The call right after it, in the same turn. */
  to: string;
  /** Times `to` came right after `from`. */
  n: number;
  /** Calls of `from` that any call followed: `n / of` is how often `to` came next. */
  of: number;
}

export interface NetworkNode {
  /** `tool:<id>` or `skill:<id>`, as on the intent map. */
  id: string;
  kind: "tool" | "skill";
  name: string;
  calls: number;
  /** Ask groups it answers on the map. */
  asks: number;
  /** The catalog no longer lists it. */
  missing: boolean;
  /** Tools it is linked to by either reading, before any is hidden. */
  partners: number;
  hub: boolean;
  /** The group it belongs to; null for a hub, or a tool with no backbone link to another that is not one. */
  group: string | null;
}

export interface NetworkLink {
  /** `source|target`. Tool ids only. */
  id: string;
  /** With `directed`, the tool that usually runs first. */
  source: string;
  target: string;
  /** Ask groups both answer, busiest first. Ids only. */
  shared: string[];
  /** "Came next" counts between the two, in either direction. */
  steps: ToolStep[];
  /** One way clearly outweighs the other: drawn with an arrow at `target`. */
  directed: boolean;
  /** 0..1: how surely the two belong together, the stronger of the two readings. */
  strength: number;
  /** Drawn at rest; the rest show only while one of its tools is lit. */
  backbone: boolean;
}

export interface NetworkGroup {
  id: string;
  /** Busiest first. */
  members: string[];
  calls: number;
  /** Only the three biggest groups wear a hue. */
  color: GroupColor | null;
}

export interface ToolNetworkModel {
  /** Keyboard order: group by group (busiest member first), then the rest, busiest first. */
  nodes: NetworkNode[];
  /** Strongest first. */
  links: NetworkLink[];
  /** Biggest first. */
  groups: NetworkGroup[];
}

export interface ToolNetworkOptions {
  k?: number;
  floor?: number;
  maxGroupSize?: number;
}

/** Tool Explorer ids are a tool's catalog id or `skill:<id>`; the map keys both kinds. */
export function explorerCapabilityKey(id: string): string {
  return id.startsWith("skill:") ? id : `tool:${id}`;
}

/** Tool Explorer next-call edges as steps between tools on the map; the rest are dropped. */
export function toolStepsFromEdges(
  edges: ReadonlyArray<Pick<ExplorerEdge, "a" | "b" | "n" | "nA">>,
  keep: ReadonlySet<string>,
): ToolStep[] {
  return edges.flatMap((edge) => {
    const from = explorerCapabilityKey(edge.a);
    const to = explorerCapabilityKey(edge.b);
    return keep.has(from) && keep.has(to) && from !== to
      ? [{ from, to, n: edge.n, of: edge.nA }]
      : [];
  });
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const wilsonLow = (k: number, n: number) => wilsonInterval(k, n)?.low ?? 0;
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const stepTotal = (link: Pick<NetworkLink, "steps">) =>
  link.steps.reduce((sum, step) => sum + step.n, 0);

/** Strongest first; ties by shared groups, then steps, then id. The one order links are ranked and joined in. */
function strongestFirst(a: NetworkLink, b: NetworkLink): number {
  return (
    b.strength - a.strength ||
    b.shared.length - a.shared.length ||
    stepTotal(b) - stepTotal(a) ||
    byId(a.id, b.id)
  );
}

/** Steps worth reading: between two tools on the map, counted often enough, keyed by direction. */
function usableSteps(
  steps: readonly ToolStep[],
  known: ReadonlySet<string>,
): Map<string, ToolStep> {
  const out = new Map<string, ToolStep>();
  for (const step of steps) {
    if (step.from === step.to || !known.has(step.from) || !known.has(step.to)) continue;
    if (
      !Number.isFinite(step.n) ||
      !Number.isFinite(step.of) ||
      step.n < MIN_STEPS ||
      step.of < step.n
    )
      continue;
    const key = `${step.from}|${step.to}`;
    const seen = out.get(key);
    // One count per direction: a repeated row keeps the larger reading.
    if (!seen || step.n > seen.n)
      out.set(key, { from: step.from, to: step.to, n: step.n, of: step.of });
  }
  return out;
}

/** Union-find over ids, with component sizes. */
function unionFind(ids: readonly string[]) {
  const parent = new Map(ids.map((id) => [id, id]));
  const size = new Map(ids.map((id) => [id, 1]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  return {
    find,
    sizeOf: (id: string) => size.get(find(id))!,
    union(a: string, b: string) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      // The smaller id roots the merged set, so the result never depends on the order of unions.
      const [root, child] = byId(ra, rb) <= 0 ? [ra, rb] : [rb, ra];
      parent.set(child, root);
      size.set(root, size.get(root)! + size.get(child)!);
    },
  };
}

export function buildToolNetwork(input: {
  model: Pick<IntentMapModel, "asks" | "capabilities" | "links">;
  steps?: readonly ToolStep[];
  options?: ToolNetworkOptions;
}): ToolNetworkModel {
  const k = input.options?.k ?? BACKBONE_K;
  const floor = input.options?.floor ?? STRENGTH_FLOOR;
  const maxGroupSize = input.options?.maxGroupSize ?? MAX_GROUP_SIZE;
  const { model } = input;
  const capabilities = [...model.capabilities].sort((a, b) => byId(a.id, b.id));
  const known = new Set(capabilities.map((capability) => capability.id));
  const volume = new Map(model.asks.map((ask) => [ask.id, ask.volume]));

  // Who answers what: each tool's ask groups, each ask group's tools.
  const asksOf = new Map<string, Set<string>>();
  const toolsOf = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };
  for (const link of model.links) {
    if (!(link.weight > 0) || !known.has(link.capability) || !volume.has(link.ask)) continue;
    add(asksOf, link.capability, link.ask);
    add(toolsOf, link.ask, link.capability);
  }

  // One link per pair of tools, from either reading.
  const pairs = new Map<string, { a: string; b: string; shared: string[]; steps: ToolStep[] }>();
  const pair = (x: string, y: string) => {
    const [a, b] = byId(x, y) <= 0 ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    let entry = pairs.get(key);
    if (!entry) {
      entry = { a, b, shared: [], steps: [] };
      pairs.set(key, entry);
    }
    return entry;
  };
  const askOrder = [...toolsOf.keys()].sort(
    (a, b) => (volume.get(b) ?? 0) - (volume.get(a) ?? 0) || byId(a, b),
  );
  for (const ask of askOrder) {
    const tools = [...toolsOf.get(ask)!].sort(byId);
    for (let i = 0; i < tools.length; i += 1) {
      for (let j = i + 1; j < tools.length; j += 1) pair(tools[i]!, tools[j]!).shared.push(ask);
    }
  }
  const steps = usableSteps(input.steps ?? [], known);
  for (const key of [...steps.keys()].sort(byId)) {
    const step = steps.get(key)!;
    pair(step.from, step.to).steps.push(step);
  }

  const links: NetworkLink[] = [...pairs.values()].map(({ a, b, shared, steps: own }) => {
    const union = (asksOf.get(a)?.size ?? 0) + (asksOf.get(b)?.size ?? 0) - shared.length;
    const sharedStrength = shared.length > 0 ? wilsonLow(shared.length, union) : 0;
    const stepStrength = Math.max(0, ...own.map((step) => wilsonLow(step.n, step.of)));
    const forward = own.find((step) => step.from === a)?.n ?? 0;
    const backward = own.find((step) => step.from === b)?.n ?? 0;
    const directed =
      forward + backward > 0 &&
      Math.max(forward, backward) >= ONE_WAY_RATIO * Math.min(forward, backward);
    const [source, target] = directed && backward > forward ? [b, a] : [a, b];
    return {
      id: `${source}|${target}`,
      source,
      target,
      shared,
      steps: [...own].sort((x, y) => (x.from === source ? -1 : 1) - (y.from === source ? -1 : 1)),
      directed,
      strength: round(Math.max(sharedStrength, stepStrength)),
      backbone: false,
    };
  });
  links.sort(strongestFirst);

  // Partners, and the most any one ask group gives a tool: what "many partners" is measured against.
  const partnersOf = new Map<string, Set<string>>();
  for (const link of links) {
    add(partnersOf, link.source, link.target);
    add(partnersOf, link.target, link.source);
  }
  const groupPeers = (id: string) =>
    Math.max(0, ...[...(asksOf.get(id) ?? [])].map((ask) => (toolsOf.get(ask)?.size ?? 1) - 1));
  const hubs = new Set(
    capabilities
      .filter((capability) => {
        const partners = partnersOf.get(capability.id)?.size ?? 0;
        return (
          (asksOf.get(capability.id)?.size ?? 0) >= HUB_GROUPS ||
          partners - groupPeers(capability.id) >= HUB_EXTRA_PARTNERS
        );
      })
      .map((capability) => capability.id),
  );

  // The backbone: each tool's strongest k, plus anything above the floor.
  const calls = new Map(capabilities.map((capability) => [capability.id, capability.calls]));
  const linksOf = new Map<string, NetworkLink[]>();
  for (const link of links) {
    for (const end of [link.source, link.target]) {
      const own = linksOf.get(end);
      if (own) own.push(link);
      else linksOf.set(end, [link]);
    }
  }
  const kept = new Set<string>(
    links.filter((link) => link.strength >= floor).map((link) => link.id),
  );
  for (const [id, own] of linksOf) {
    const partner = (link: NetworkLink) => (link.source === id ? link.target : link.source);
    const ranked = [...own].sort(
      (x, y) =>
        y.strength - x.strength ||
        y.shared.length - x.shared.length ||
        stepTotal(y) - stepTotal(x) ||
        (calls.get(partner(y)) ?? 0) - (calls.get(partner(x)) ?? 0) ||
        byId(partner(x), partner(y)),
    );
    for (const link of ranked.slice(0, k)) kept.add(link.id);
  }
  const ranked = links.map((link) => ({ ...link, backbone: kept.has(link.id) }));

  // Groups: the backbone without hubs, joined strongest first and never past the cap.
  const sets = unionFind(capabilities.map((capability) => capability.id));
  for (const link of ranked) {
    if (!link.backbone || hubs.has(link.source) || hubs.has(link.target)) continue;
    if (sets.find(link.source) === sets.find(link.target)) continue;
    if (sets.sizeOf(link.source) + sets.sizeOf(link.target) > maxGroupSize) continue;
    sets.union(link.source, link.target);
  }
  const busiestFirst = (a: string, b: string) =>
    (calls.get(b) ?? 0) - (calls.get(a) ?? 0) || byId(a, b);
  const members = new Map<string, string[]>();
  for (const capability of capabilities) {
    if (hubs.has(capability.id)) continue;
    const root = sets.find(capability.id);
    const list = members.get(root);
    if (list) list.push(capability.id);
    else members.set(root, [capability.id]);
  }
  const groups: NetworkGroup[] = [...members.values()]
    .filter((list) => list.length >= 2)
    .map((list) => {
      const sorted = [...list].sort(busiestFirst);
      return { members: sorted, calls: sorted.reduce((sum, id) => sum + (calls.get(id) ?? 0), 0) };
    })
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        b.calls - a.calls ||
        byId(a.members[0]!, b.members[0]!),
    )
    .map((group, index) => ({
      id: `g${index + 1}`,
      ...group,
      color: index < GROUP_COLORS.length ? GROUP_COLORS[index]! : null,
    }));
  const groupOf = new Map(
    groups.flatMap((group) => group.members.map((id) => [id, group.id] as const)),
  );

  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const nodeOf = (id: string): NetworkNode => {
    const capability = capabilityById.get(id)!;
    return {
      id,
      kind: capability.kind,
      name: capability.name,
      calls: capability.calls,
      asks: asksOf.get(id)?.size ?? 0,
      missing: capability.missing,
      partners: partnersOf.get(id)?.size ?? 0,
      hub: hubs.has(id),
      group: groupOf.get(id) ?? null,
    };
  };
  const grouped = groups.flatMap((group) => group.members);
  const rest = capabilities
    .map((capability) => capability.id)
    .filter((id) => !groupOf.has(id))
    .sort(busiestFirst);
  return { nodes: [...grouped, ...rest].map(nodeOf), links: ranked, groups };
}

/**
 * What the drawing's positions depend on: the tools and their calls, the
 * links kept at rest and how strong they are, and the groups. A new copy of
 * the same model keeps the drawing, and the reader's pan and zoom.
 */
export function networkLayoutKey(network: ToolNetworkModel): string {
  return JSON.stringify([
    network.nodes.map((node) => [node.id, node.calls, node.hub, node.group]),
    network.links.filter((link) => link.backbone).map((link) => [link.id, link.strength]),
    network.groups.map((group) => [group.id, group.color]),
  ]);
}

/** A tool and every tool one link away, hidden links included: what lights when it is pointed at. */
export function networkNeighbours(
  network: Pick<ToolNetworkModel, "links">,
  id: string,
): Set<string> {
  const out = new Set<string>([id]);
  for (const link of network.links) {
    if (link.source === id) out.add(link.target);
    else if (link.target === id) out.add(link.source);
  }
  return out;
}

// --- words -----------------------------------------------------------------------

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A tool's accessible name: its name and numbers, and where it lives when it
 * is not in one task (`home`). Tool names are ids, never user text; a task's
 * name is model-written, so it stays out.
 */
export function networkNodeName(
  node: NetworkNode,
  home: "task" | "group" | "shared" | "other" | null = null,
): string {
  const where =
    home === "shared"
      ? ", shared by many tasks"
      : home === "other"
        ? ", in no task"
        : home === null && node.hub
          ? ", widely shared"
          : "";
  return (
    `${node.name}, ${node.kind}: ${count(node.calls, "call", "calls")} across ${count(node.asks, "intent", "intents")}, ` +
    `linked to ${count(node.partners, "tool", "tools")}${where}${node.missing ? ", not in your catalog" : ""}`
  );
}

/** How many ask labels a link's reason names before it counts the rest. */
export const REASON_LABELS = 3;

/**
 * Why two tools are linked, one sentence per reading, for visible text only:
 * the ask labels are raw user text and must never reach an attribute.
 */
export function linkReasons(
  link: Pick<NetworkLink, "shared" | "steps">,
  nameOf: (id: string) => string,
  labelOf: (askId: string) => string | null,
): string[] {
  const out: string[] = [];
  if (link.shared.length > 0) {
    const labels = link.shared.slice(0, REASON_LABELS).map((ask) => labelOf(ask) ?? ask);
    const more = link.shared.length - labels.length;
    out.push(
      `Both serve ${link.shared.length === 1 ? "the same intent" : `${link.shared.length} of the same intents`}: ` +
        `${labels.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
    );
  }
  for (const step of link.steps) {
    out.push(
      `${nameOf(step.to)} came next after ${nameOf(step.from)} in ${step.n.toLocaleString("en-US")} of ${count(step.of, "call", "calls")}.`,
    );
  }
  return out;
}
