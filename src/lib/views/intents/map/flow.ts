/**
 * The Flow lens's data: intents on the left, the tools and skills that
 * answered them on the right, one ribbon per pair sized by calls. Shaped here
 * for `d3-sankey`, which only lays it out. Calm on purpose: only the busiest
 * intents and tools get a row of their own and the rest share one Other row
 * on each side; intents are grouped by their main task (the colored tasks
 * first) and the right column follows where its intents sit, so ribbons run
 * in bands and cross little. Every row and ribbon carries its task's color
 * (`lib/tasks/palette.ts`): an intent its main task's, a tool and the ribbons
 * into it the tool's.
 */
import type { IntentMapModel, MapTint } from "@/lib/views/intents/map/map-model";

export const FLOW_MAX_ASKS = 8;
export const FLOW_MAX_CAPABILITIES = 10;
/** An intent's own ribbons: its busiest tools, at most this many... */
export const FLOWS_PER_ASK = 4;
/** ...each at least this share of its calls (its busiest one always); the trickles run into Other. */
export const MIN_FLOW_SHARE = 0.05;
export const OTHER_ASKS = "ask:other";
export const OTHER_CAPABILITIES = "capability:other";

/** The colored tasks in palette order; a neutral task comes after them. */
const TINT_ORDER: Record<MapTint, number> = { "chart-1": 0, "chart-5": 1, "chart-4": 2 };
const tintRank = (tint: MapTint | null | undefined) => (tint ? TINT_ORDER[tint] : 3);

export interface FlowNode {
  /** `ask:<cluster id>`, `capability:<kind:id>`, or one of the two Other rows. */
  id: string;
  side: "ask" | "capability";
  label: string;
  /** The map's own id for the intent or capability; null for an Other row. */
  ref: string | null;
  kind: "tool" | "skill" | null;
  /** Calls through this row. */
  value: number;
  /** How many intents or capabilities an Other row stands for. */
  folded: number;
  /** Its task's color: an intent's main task, a tool's; null for a neutral task or an Other row. */
  tint: MapTint | null;
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
  /** The color of the tool it runs into; null when that tool's task is neutral, or it runs into Other. */
  tint: MapTint | null;
}

export interface FlowData {
  nodes: FlowNode[];
  links: FlowLink[];
  total: number;
}

/**
 * A row's accessible name. An intent is named by its id, never its label (a
 * raw user query, kept out of attributes); a tool by its name; an Other row
 * by what it folds.
 */
export function flowNodeName(node: FlowNode): string {
  const calls = `${node.value.toLocaleString("en-US")} ${node.value === 1 ? "call" : "calls"}`;
  if (node.side === "ask" && node.ref !== null) return `Intent ${node.ref}: ${calls}`;
  return `${node.label}: ${calls}`;
}

export function buildFlowData(
  model: IntentMapModel,
  limits: { asks?: number; capabilities?: number } = {},
): FlowData {
  const maxAsks = limits.asks ?? FLOW_MAX_ASKS;
  const maxCapabilities = limits.capabilities ?? FLOW_MAX_CAPABILITIES;

  // Each intent's main flows: its busiest tools, a few, each a fair share of its calls.
  const main = new Set<string>();
  const byAsk = new Map<string, typeof model.links>();
  for (const link of model.links) {
    if (!(link.weight > 0)) continue;
    byAsk.set(link.ask, [...(byAsk.get(link.ask) ?? []), link]);
  }
  for (const [ask, own] of byAsk) {
    const total = own.reduce((sum, link) => sum + link.weight, 0);
    [...own]
      .sort((a, b) => b.weight - a.weight || (a.capability < b.capability ? -1 : 1))
      .forEach((link, index) => {
        if (index === 0 || (index < FLOWS_PER_ASK && link.weight >= total * MIN_FLOW_SHARE))
          main.add(`${ask}|${link.capability}`);
      });
  }
  const isMain = (link: { ask: string; capability: string }) =>
    main.has(`${link.ask}|${link.capability}`);

  const callsByAsk = new Map<string, number>();
  const callsByCapability = new Map<string, number>();
  for (const link of model.links) {
    if (!(link.weight > 0)) continue;
    callsByAsk.set(link.ask, (callsByAsk.get(link.ask) ?? 0) + link.weight);
    // A tool earns its row by the calls of the flows it is a main tool in.
    if (isMain(link))
      callsByCapability.set(
        link.capability,
        (callsByCapability.get(link.capability) ?? 0) + link.weight,
      );
  }
  const busiest =
    <T extends { id: string }>(calls: Map<string, number>) =>
    (a: T, b: T) =>
      (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const asks = model.asks
    .filter((ask) => (callsByAsk.get(ask.id) ?? 0) > 0)
    .sort(busiest(callsByAsk));
  const capabilities = model.capabilities
    .filter((capability) => (callsByCapability.get(capability.id) ?? 0) > 0)
    .sort(busiest(callsByCapability));
  // One Other row is only worth drawing when it folds more than one item.
  const keptAsks = (asks.length > maxAsks ? asks.slice(0, maxAsks - 1) : asks)
    // The busiest intents, grouped by their main task, colored tasks first, so ribbons run in bands.
    .sort((a, b) => tintRank(a.tint) - tintRank(b.tint) || busiest(callsByAsk)(a, b));
  const keptCapabilities =
    capabilities.length > maxCapabilities
      ? capabilities.slice(0, maxCapabilities - 1)
      : capabilities;
  const askRow = new Map(keptAsks.map((ask) => [ask.id, `ask:${ask.id}`]));
  const capabilityRow = new Map(
    keptCapabilities.map((capability) => [capability.id, `capability:${capability.id}`]),
  );
  const tintOf = new Map(
    keptCapabilities.map((capability) => [`capability:${capability.id}`, capability.tint ?? null]),
  );

  const values = new Map<string, FlowLink>();
  for (const link of model.links) {
    if (!(link.weight > 0)) continue;
    const source = askRow.get(link.ask) ?? OTHER_ASKS;
    const target =
      (isMain(link) ? capabilityRow.get(link.capability) : undefined) ?? OTHER_CAPABILITIES;
    const key = `${source}|${target}`;
    const current = values.get(key);
    if (current) current.value += link.weight;
    else values.set(key, { source, target, value: link.weight, tint: tintOf.get(target) ?? null });
  }
  const links = [...values.values()];

  const sum = (id: string, side: "source" | "target") =>
    links.filter((link) => link[side] === id).reduce((total, link) => total + link.value, 0);

  const left: FlowNode[] = keptAsks.map((ask) => ({
    id: `ask:${ask.id}`,
    side: "ask",
    label: ask.label,
    ref: ask.id,
    kind: null,
    value: sum(`ask:${ask.id}`, "source"),
    folded: 1,
    tint: ask.tint ?? null,
  }));
  if (asks.length > keptAsks.length) {
    const folded = asks.length - keptAsks.length;
    left.push({
      id: OTHER_ASKS,
      side: "ask",
      label: `${folded} other intents`,
      ref: null,
      kind: null,
      value: sum(OTHER_ASKS, "source"),
      folded,
      tint: null,
    });
  }

  // Barycentre ordering: each capability sits at the weighted mean row of the intents feeding it.
  const rowOf = new Map(left.map((node, index) => [node.id, index]));
  const centre = (id: string) => {
    let weight = 0;
    let total = 0;
    for (const link of links) {
      if (link.target !== id) continue;
      weight += (rowOf.get(link.source) ?? left.length) * link.value;
      total += link.value;
    }
    return total > 0 ? weight / total : left.length;
  };
  const right: FlowNode[] = keptCapabilities
    .map((capability) => ({
      id: `capability:${capability.id}`,
      side: "capability" as const,
      label: capability.name,
      ref: capability.id,
      kind: capability.kind,
      value: sum(`capability:${capability.id}`, "target"),
      folded: 1,
      tint: capability.tint ?? null,
    }))
    .sort((a, b) => centre(a.id) - centre(b.id) || b.value - a.value);
  // The tools without a row of their own, and every intent's trickles, share one Other row.
  if (links.some((link) => link.target === OTHER_CAPABILITIES)) {
    const used = new Set(
      model.links.filter((link) => link.weight > 0).map((link) => link.capability),
    );
    const folded = [...used].filter((id) => !capabilityRow.has(id)).length;
    right.push({
      id: OTHER_CAPABILITIES,
      side: "capability",
      label: folded > 0 ? `${folded} other ${folded === 1 ? "tool" : "tools"}` : "Other tools",
      ref: null,
      kind: null,
      value: sum(OTHER_CAPABILITIES, "target"),
      folded,
      tint: null,
    });
  }

  // Ribbons in row order on both ends, so each node's ribbons stack top to bottom.
  const order = new Map([...left, ...right].map((node, index) => [node.id, index]));
  links.sort(
    (a, b) =>
      order.get(a.source)! - order.get(b.source)! || order.get(a.target)! - order.get(b.target)!,
  );
  return {
    nodes: [...left, ...right],
    links,
    total: links.reduce((total, link) => total + link.value, 0),
  };
}

/** The colored tasks a flow shows, in palette order: what its legend names. */
export function flowTints(data: Pick<FlowData, "nodes">): MapTint[] {
  return [...new Set(data.nodes.flatMap((node) => (node.tint ? [node.tint] : [])))].sort(
    (a, b) => tintRank(a) - tintRank(b),
  );
}
