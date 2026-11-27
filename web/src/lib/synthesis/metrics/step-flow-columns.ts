import type { StepFlowQuery, StepFlowStart } from "@/lib/contracts/query";

/**
 * Step paths folded into columns: the start, one per step, and Later. Pure and safe for the
 * browser, so the query and a widget that unfolds a bucket count the same way.
 */

/** One way traces went, with how many went it. Names are indexes into `StepFlowPaths.names`. */
export interface StepFlowPath {
  start: number;
  /** Its first steps, up to the most a step flow can show. In mode before, nearest first. */
  steps: number[];
  /** It went on past them. */
  more: boolean;
  count: number;
}

export interface StepFlowPaths {
  names: string[];
  paths: StepFlowPath[];
}

/** "rest": the column's bucket. "ended": no such step (in mode before: nothing earlier). */
export type StepFlowNodeKind = "start" | "node" | "rest" | "ended" | "later";

export interface StepFlowNodeCount {
  /** Unique in the flow, and the same however the flow is folded. */
  key: string;
  kind: StepFlowNodeKind;
  /** Empty for the kinds that are no one node. */
  name: string;
  count: number;
  /** Of all the traces. */
  share: number;
  /** The nodes a bucket folds; 0 elsewhere. */
  folded: number;
}

export interface StepFlowColumn {
  role: "start" | "step" | "later";
  /** 0 for the start; for Later, the first step it folds. */
  step: number;
  /** Traces that made this step. */
  count: number;
  /** The most traces first, then the bucket, then Ended. */
  nodes: StepFlowNodeCount[];
}

/** Traces that went from one node to one of the next column. */
export interface StepFlowLink {
  source: string;
  target: string;
  count: number;
}

/** The node keys a path goes through, and the name it is coloured by: its first step. */
export interface StepFlowRoute {
  keys: string[];
  first: string | null;
  count: number;
}

export interface StepFlowFold {
  total: number;
  columns: StepFlowColumn[];
  links: StepFlowLink[];
  routes: StepFlowRoute[];
}

/** Nodes shown over the limit, by step: 0 is the start column. */
export type StepFlowExpanded = Readonly<Record<number, number>>;

/** Ids the Health map's drawing knows (`views/health/flow-journey-layout`). */
const REST = "~other";
const LATER = "later";

/** The names of a trace with nothing to group it by. */
export const NO_GROUP: Readonly<Record<StepFlowStart, string>> = {
  none: "All traces",
  agent: "No agent",
  intent: "No intent",
};

export function foldStepFlow(
  { names, paths }: StepFlowPaths,
  { steps, nodes }: Pick<StepFlowQuery, "steps" | "nodes">,
  expanded: StepFlowExpanded = {},
): StepFlowFold {
  const total = paths.reduce((sum, { count }) => sum + count, 0);
  const reached = Math.max(0, ...paths.map((path) => path.steps.length));
  const depth = Math.max(1, Math.min(steps, reached));
  const shown = Array.from({ length: depth + 1 }, (_, step) =>
    topNames(paths, names, step, nodes + (expanded[step] ?? 0)),
  );
  const folded = new Map<string, number>();
  const keyAt = (step: number, index: number) => {
    const { kept, left } = shown[step];
    const prefix = step === 0 ? "s" : `c${step}`;
    if (kept.has(index)) return `${prefix}:${names[index]}`;
    const key = `${prefix}:${REST}`;
    folded.set(key, left);
    return key;
  };
  const routes = merged(
    paths.map((path) => {
      const within = path.steps.slice(0, depth);
      const goesOn = path.more || path.steps.length > depth;
      return {
        keys: [
          keyAt(0, path.start),
          ...within.map((index, at) => keyAt(at + 1, index)),
          goesOn ? LATER : `e${within.length + 1}`,
        ],
        first: path.steps.length > 0 ? names[path.steps[0]] : null,
        count: path.count,
      };
    }),
  );

  const counts = new Map<string, number>();
  const links = new Map<string, StepFlowLink>();
  const columnOf = new Map<string, number>();
  for (const { keys, count } of routes)
    for (const [at, key] of keys.entries()) {
      counts.set(key, (counts.get(key) ?? 0) + count);
      columnOf.set(key, at);
      const next = keys[at + 1];
      if (next === undefined) continue;
      const id = JSON.stringify([key, next]);
      const link = links.get(id) ?? { source: key, target: next, count: 0 };
      link.count += count;
      links.set(id, link);
    }
  const columns = Array.from({ length: depth + 2 }, (_, step): StepFlowColumn => {
    const placed = [...counts]
      .filter(([key]) => columnOf.get(key) === step)
      .map(
        ([key, count]): StepFlowNodeCount => ({
          key,
          ...kindOf(key),
          count,
          share: total > 0 ? count / total : 0,
          folded: folded.get(key) ?? 0,
        }),
      )
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count || compare(a.name, b.name),
      );
    return {
      role: step === 0 ? "start" : step > depth ? "later" : "step",
      step,
      count: placed.reduce((sum, { kind, count }) => sum + (kind === "ended" ? 0 : count), 0),
      nodes: placed,
    };
  });
  const place = (key: string) => columnOf.get(key) ?? 0;
  return {
    total,
    columns,
    links: [...links.values()].sort(
      (a, b) =>
        place(a.source) - place(b.source) ||
        b.count - a.count ||
        compare(a.source, b.source) ||
        compare(a.target, b.target),
    ),
    routes,
  };
}

const KIND_ORDER: Readonly<Record<StepFlowNodeKind, number>> = {
  start: 0,
  node: 0,
  later: 0,
  rest: 1,
  ended: 2,
};

/** The busiest names of a step, and how many are left over. */
function topNames(
  paths: readonly StepFlowPath[],
  names: readonly string[],
  step: number,
  limit: number,
): { kept: Set<number>; left: number } {
  const counts = new Map<number, number>();
  for (const { start, steps, count } of paths) {
    const index = step === 0 ? start : steps[step - 1];
    if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + count);
  }
  const ranked = [...counts]
    .sort((a, b) => b[1] - a[1] || compare(names[a[0]], names[b[0]]))
    .map(([index]) => index);
  return { kept: new Set(ranked.slice(0, limit)), left: Math.max(0, ranked.length - limit) };
}

function kindOf(key: string): Pick<StepFlowNodeCount, "kind" | "name"> {
  if (key === LATER) return { kind: "later", name: "" };
  const colon = key.indexOf(":");
  if (colon < 0) return { kind: "ended", name: "" };
  const name = key.slice(colon + 1);
  if (name === REST) return { kind: "rest", name: "" };
  return { kind: key.startsWith("s") ? "start" : "node", name };
}

function merged(routes: readonly StepFlowRoute[]): StepFlowRoute[] {
  const byKeys = new Map<string, StepFlowRoute>();
  for (const route of routes) {
    const id = JSON.stringify([route.keys, route.first]);
    const same = byKeys.get(id);
    if (same) same.count += route.count;
    else byKeys.set(id, { ...route });
  }
  return [...byKeys.values()].sort(
    (a, b) => b.count - a.count || compare(a.keys.join(">"), b.keys.join(">")),
  );
}

/** The order of the bytes, so it does not move with a locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
