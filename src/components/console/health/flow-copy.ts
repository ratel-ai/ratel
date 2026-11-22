import type { FlowTint } from "@/lib/readings/trace-signals/view";
import type { FlowLayoutEdge, FlowLayoutNode } from "@/lib/views/health/flow-layout";

/**
 * Words for the tool flow map: the rows' aria-labels, the hover and pinned
 * cards, the ribbons' native titles and their counts in focus. Kept apart from
 * the drawing so the copy reads in one place and the tests can pin it.
 */

/** The tint as one word, for aria-labels; `none` says nothing. */
export const TINT_WORD: Record<FlowTint, string | null> = {
  magnet: "magnet",
  buried: "buried",
  dead: "dead",
  healthy: "healthy",
  none: null,
};

/** What the tint means, for the cards and the legend. */
export const TINT_MEANING: Record<FlowTint, string> = {
  magnet: "Listed often, rarely picked",
  buried: "Picked from far down the list",
  dead: "Never picked",
  healthy: "Found first and used",
  none: "Nothing to flag",
};

function times(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "time" : "times"}`;
}

function turns(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "turn" : "turns"}`;
}

/**
 * A tool's counts in words. A tool no recorded search listed says so, rather
 * than "listed 0, picked 20", which reads as impossible: it ran, but never
 * after a search that Ratel saw.
 */
export function toolCounts(impressions: number, invocations: number): string {
  if (invocations === 0 && impressions === 0) return "never run";
  if (impressions === 0) return `run ${times(invocations)}, never after a search`;
  return `listed ${times(impressions)}, run ${times(invocations)}`;
}

/** "create_task: listed 509 times, run 12 times, magnet". */
export function flowNodeAriaLabel(node: FlowLayoutNode): string {
  if (node.kind === "search") return "Search: where every turn starts";
  if (node.kind === "more") {
    return node.moreCount
      ? `Show ${node.moreCount} more ${node.moreCount === 1 ? "tool" : "tools"}`
      : "Show fewer tools";
  }
  const tint = TINT_WORD[node.tint];
  return `${node.label}: ${toolCounts(node.impressions, node.invocations)}${tint ? `, ${tint}` : ""}`;
}

/** Compact counts for the cards and ribbons: 1,106 stays whole, 12,410 reads 12.4k. */
export function compactCount(count: number): string {
  if (count < 10_000) return count.toLocaleString("en-US");
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** The native tooltip on a ribbon. */
export function flowEdgeTitle(edge: FlowLayoutEdge, labels: ReadonlyMap<string, string>): string {
  const from = labels.get(edge.from) ?? edge.fromId;
  const to = labels.get(edge.to) ?? edge.toId;
  if (edge.kind === "sibling")
    return `${from} and ${to} picked interchangeably: ${turns(edge.count)}`;
  if (edge.kind === "pick") return `Search led to ${to}: ${turns(edge.count)}`;
  return `${from} then ${to}: ${turns(edge.count)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function percent(share: number): string {
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
}

/** The label a lit ribbon carries in focus: its turns, and its share where it has one. */
export function flowEdgeCount(edge: FlowLayoutEdge): string {
  if (edge.kind === "sequence" && edge.confidence > 0)
    return `${compactCount(edge.count)} · ${percent(edge.confidence)}`;
  return compactCount(edge.count);
}

export interface FlowFocusCopy {
  title: string;
  lines: string[];
  meaning: string | null;
}

function nameOf(key: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(key) ?? key;
}

/**
 * What a card says about a tool in focus: its counts, where its turns went
 * next and came from, and what its colour means. `edges` is the whole layout's.
 */
export function flowFocusCopy(
  node: FlowLayoutNode,
  edges: readonly FlowLayoutEdge[],
  labels: ReadonlyMap<string, string>,
  opens: boolean,
): FlowFocusCopy {
  if (node.kind === "search") {
    const picks = edges.filter((edge) => edge.kind === "pick");
    const total = picks.reduce((sum, edge) => sum + edge.count, 0);
    return {
      title: "Search",
      lines: [`Where every turn starts · led to a tool in ${turns(total)}`],
      meaning: null,
    };
  }
  if (node.kind === "more") {
    return {
      title: node.label,
      lines: [
        `${turns(node.weight)} between them`,
        node.moreCount ? "Click to show them all" : "Click to fold the quieter tools",
      ],
      meaning: null,
    };
  }
  const counts =
    node.kind === "quiet"
      ? `Too little traffic to draw one by one · run ${times(node.invocations)}`
      : node.impressions === 0
        ? capitalize(toolCounts(0, node.invocations))
        : `Listed ${compactCount(node.impressions)} · run ${times(node.invocations)}`;
  const byCount = (a: FlowLayoutEdge, b: FlowLayoutEdge) =>
    b.count - a.count || (a.key < b.key ? -1 : 1);
  const next = edges
    .filter((edge) => edge.kind === "sequence" && edge.fromId === node.id)
    .sort(byCount);
  const before = edges
    .filter((edge) => edge.kind === "sequence" && edge.toId === node.id)
    .sort(byCount);
  const lines = [counts];
  if (next[0]) {
    const more = next.length > 1 ? `, ${next.length - 1} more` : "";
    lines.push(
      `Then ${nameOf(next[0].to, labels)} in ${percent(next[0].confidence)} of its turns${more}`,
    );
  }
  if (before[0]) {
    const more = before.length > 1 ? `, ${before.length - 1} more` : "";
    lines.push(`After ${nameOf(before[0].from, labels)} in ${turns(before[0].count)}${more}`);
  }
  const meaning =
    node.kind === "quiet" || (node.tint === "none" && opens) ? null : TINT_MEANING[node.tint];
  return { title: node.label, lines, meaning };
}
