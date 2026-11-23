import type {
  FlowEdge,
  FlowJourney,
  FlowJourneyFlag,
  FlowJourneyPath,
  FlowJourneyStart,
  FlowJourneyTool,
  FlowModel,
  FlowNode,
  FlowTint,
} from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";

/**
 * A synthetic flow model of any size, for the flow map's tests and for
 * looking at a large catalog by eye. Deterministic: the same arguments give
 * the same model. Traffic falls off like a real catalog's (a few busy tools, a
 * long tail), names are long and alike, and every tint appears.
 */

const VERBS = [
  "search",
  "get",
  "create",
  "update",
  "delete",
  "list",
  "link",
  "export",
  "assign",
  "archive",
] as const;
const NOUNS = [
  "task",
  "project",
  "document",
  "comment",
  "task_relationship",
  "pull_request",
  "member",
  "label",
  "milestone",
  "workflow_run",
  "attachment",
  "notification_rule",
] as const;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function toolName(i: number): string {
  const verb = VERBS[i % VERBS.length];
  const noun = NOUNS[Math.floor(i / VERBS.length) % NOUNS.length];
  const round = Math.floor(i / (VERBS.length * NOUNS.length));
  return round === 0 ? `${verb}_${noun}` : `${verb}_${noun}_v${round + 1}`;
}

function tintFor(i: number, invocations: number): FlowTint {
  if (i % 17 === 11) return "magnet";
  if (i % 13 === 6) return "buried";
  if (invocations >= 60 && i % 3 === 0) return "healthy";
  return "none";
}

/** A model with `tools` tools, three of them dead, and edges shaped like a real run. */
export function syntheticFlow(tools: number, seed = 7): FlowModel {
  const random = seeded(seed);
  const nodes: FlowNode[] = [
    {
      id: "search",
      kind: "search",
      label: "Search",
      invocations: 0,
      impressions: 0,
      tint: "none",
      signalIds: [],
    },
  ];
  const edges: FlowEdge[] = [];
  const live = Math.max(0, tools - 3);
  for (let i = 0; i < tools; i += 1) {
    const id = toolName(i);
    const dead = i >= live;
    const invocations = dead ? 0 : Math.max(1, Math.round(1_400 / (i + 1) ** 0.95));
    const tint = dead ? "dead" : tintFor(i, invocations);
    const impressions = dead
      ? 0
      : Math.round(invocations * (tint === "magnet" ? 30 : 1.5 + random() * 3));
    const signalIds = tint === "none" || tint === "healthy" ? [] : [`sig-${tint}-${id}`];
    nodes.push({ id, kind: "tool", label: id, invocations, impressions, tint, signalIds });
    // Most tools are picked from search; one in five only runs after another tool.
    if (!dead && i % 5 !== 4) {
      const picks =
        tint === "magnet"
          ? Math.max(1, Math.round(invocations * 0.3))
          : Math.round(invocations * 0.8);
      if (picks > 0) {
        edges.push({
          from: "search",
          to: id,
          kind: "pick",
          count: picks,
          confidence: 0.6 + random() * 0.35,
          tint,
          signalIds,
        });
      }
    }
  }
  // "Ran next": busy tools lead to a few others, weighted toward the busy end.
  const pairs = new Set<string>();
  const sequences = Math.min(60, Math.floor(live * 0.6));
  for (let n = 0; pairs.size < sequences && n < sequences * 10; n += 1) {
    const a = Math.floor(random() ** 2 * live);
    const b = Math.floor(random() ** 1.4 * live);
    const key = `${a}>${b}`;
    if (a === b || pairs.has(key)) continue;
    pairs.add(key);
    const from = nodes[a + 1];
    const count = Math.max(3, Math.round(from.invocations * (0.05 + random() * 0.3)));
    edges.push({
      from: from.id,
      to: nodes[b + 1].id,
      kind: "sequence",
      count,
      confidence: Math.min(1, count / Math.max(1, from.invocations)),
      tint: "none",
      signalIds: n % 9 === 0 ? [`sig-chain-${key}`] : [],
    });
  }
  // A few sibling pairs among the picked tools.
  for (let i = 0; i + 1 < Math.min(live, 40); i += 9) {
    const a = nodes[i + 1].id;
    const b = nodes[i + 2].id;
    const buried = i === 9;
    edges.push({
      from: a < b ? a : b,
      to: a < b ? b : a,
      kind: "sibling",
      count: 4 + (i % 7),
      confidence: 0.5,
      tint: buried ? "buried" : "none",
      signalIds: buried ? [`sig-siblings-${a}`] : [],
    });
  }
  return { nodes, edges, totalTools: tools };
}

/** Tools a synthetic journey keeps by name at each position, like a real run. */
const JOURNEY_KEPT = 16;
const JOURNEY_STEPS = 8;

interface RawTurn {
  start: FlowJourneyStart;
  tools: string[];
}

function rawTurns(live: readonly FlowNode[], turns: number, random: () => number): RawTurn[] {
  const pickTool = () =>
    live[Math.min(live.length - 1, Math.floor(random() ** 2.2 * live.length))].id;
  return Array.from({ length: turns }, () => {
    const start: FlowJourneyStart = random() < 0.33 ? "search" : "none";
    const calls = random() < 0.05 ? 0 : 1 + Math.floor(random() ** 2.5 * 11);
    const tools: string[] = [];
    for (let i = 0; i < calls; i += 1)
      tools.push(i > 0 && random() < 0.2 ? tools[i - 1] : pickTool());
    return { start: calls === 0 ? "search" : start, tools };
  });
}

function keptPerStep(raw: readonly RawTurn[]): Set<string>[] {
  return Array.from({ length: JOURNEY_STEPS }, (_, step) => {
    const counts = new Map<string, number>();
    for (const turn of raw) {
      const id = turn.tools[step];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return new Set(ranked.slice(0, JOURNEY_KEPT).map(([id]) => id));
  });
}

/**
 * A synthetic journey over a model's tools: `turns` turns, a third starting
 * with a search, most stopping after a call or two, a tail running on, and one
 * call in five repeating the tool before it. Folded like a real run: the
 * busiest tools of each position by name, the rest as "other".
 */
export function syntheticJourney(model: FlowModel, turns = 4_000, seed = 11): FlowJourney {
  const live = model.nodes.filter((node) => node.kind === "tool" && node.tint !== "dead");
  const raw = rawTurns(live, turns, seeded(seed));
  const kept = keptPerStep(raw);
  const folded = Array.from({ length: JOURNEY_STEPS }, () => new Set<string>());
  const paths = new Map<string, FlowJourneyPath>();
  for (const turn of raw) {
    const tools = turn.tools.slice(0, JOURNEY_STEPS).map((id, i) => {
      if (kept[i].has(id)) return id;
      folded[i].add(id);
      return FLOW_JOURNEY_OTHER;
    });
    const end = turn.tools.length > JOURNEY_STEPS ? ("more" as const) : ("ended" as const);
    const key = [turn.start, end, ...tools].join("|");
    paths.set(key, { start: turn.start, tools, end, turns: (paths.get(key)?.turns ?? 0) + 1 });
  }
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const ids = [...new Set([...paths.values()].flatMap((path) => path.tools))].sort();
  const tools = ids.map((id): FlowJourneyTool => {
    const node = byId.get(id);
    if (id === FLOW_JOURNEY_OTHER || !node) {
      return { id, kind: "other", label: "Other tools", tint: "none", signalIds: [], flags: [] };
    }
    const flags: FlowJourneyFlag[] =
      node.invocations % 7 === 3 ? ["errors"] : node.invocations % 11 === 5 ? ["slow"] : [];
    return {
      id,
      kind: "tool",
      label: node.label,
      tint: node.tint,
      signalIds: node.signalIds,
      flags,
    };
  });
  return {
    steps: JOURNEY_STEPS,
    turns,
    paths: [...paths.values()].sort(
      (a, b) => b.turns - a.turns || (a.tools.join() < b.tools.join() ? -1 : 1),
    ),
    tools,
    otherTools: folded.map((set) => set.size),
    searchSignalIds: [],
  };
}

/** {@link syntheticFlow} with a {@link syntheticJourney}, as a run stored today carries. */
export function syntheticJourneyFlow(tools: number, seed = 7): FlowModel {
  const flow = syntheticFlow(tools, seed);
  return { ...flow, journey: syntheticJourney(flow) };
}
