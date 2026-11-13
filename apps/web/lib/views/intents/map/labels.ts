/**
 * Plain names for what the intent graph holds (DESIGN.md, Glossary: a cluster
 * is an "ask group", the graph is the "intent map"). Pure, so the server page,
 * the map and the tests share one wording.
 *
 * A group's stored label is one of its own members, the shortest: raw text a
 * person typed, lower case, sometimes with an id or a question mark. The
 * display label keeps the words and tidies the edges. It never falls back to
 * the cluster id, which means nothing to a reader.
 */
import {
  CLOUD_INTENT_GRAPH_KEY,
  cloudGraphSource,
  type IntentGraphProducer,
} from "@/lib/readings/intent-types/wire";

/** Longest label shown in a table cell or on the map before it is cut at a word. */
export const ASK_LABEL_MAX = 56;

export interface AskLabelInput {
  label: string;
  labelOverride?: string | null;
  terms?: readonly string[];
}

/** Collapse whitespace, drop trailing punctuation, capitalize the first letter. */
export function tidyAsk(text: string): string {
  const collapsed = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?!.,;:]+$/u, "");
  if (collapsed.length === 0) return "";
  return collapsed.charAt(0).toLocaleUpperCase("en-US") + collapsed.slice(1);
}

/** Cut at the last word boundary that fits, with an ellipsis. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:]+$/u, "")}…`;
}

/**
 * The name a reader sees for an ask group: Cloud's chosen name when there is
 * one, else the group's representative ask, else its most telling words.
 */
export function askGroupLabel(input: AskLabelInput, max: number = ASK_LABEL_MAX): string {
  const chosen = tidyAsk(input.labelOverride ?? "") || tidyAsk(input.label);
  if (chosen) return truncateWords(chosen, max);
  const words = (input.terms ?? []).filter((term) => term.trim().length > 0).slice(0, 3);
  return words.length > 0 ? tidyAsk(words.join(", ")) : "Unnamed ask";
}

const NBSP = " ";

/** Relative time for a stat or a list ("12 min ago"); the absolute time goes beside it. */
export function timeAgo(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1_000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${NBSP}min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}${NBSP}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}${NBSP}days ago`;
  return absoluteDate(date);
}

/** "15 Oct 2026" */
export function absoluteDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "15 Oct 2026, 14:02 UTC" */
export function absoluteTime(date: Date): string {
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${absoluteDate(date)}, ${time}${NBSP}UTC`;
}

/** One option in the graph picker. */
export interface GraphChoice {
  graphKey: string;
  label: string;
  /** Who made it: Cloud from every runtime, Cloud from one, or a runtime itself. */
  origin: "cloud" | "cloud-source" | "runtime";
}

/** The picker's wording for a stored graph. */
export function graphChoiceLabel(graphKey: string, producer: IntentGraphProducer): GraphChoice {
  if (producer === "cloud") {
    const source = cloudGraphSource(graphKey);
    if (graphKey === CLOUD_INTENT_GRAPH_KEY || source === null) {
      return { graphKey, label: "All runtimes", origin: "cloud" };
    }
    return { graphKey, label: `${source} only`, origin: "cloud-source" };
  }
  return { graphKey, label: `${graphKey} (uploaded)`, origin: "runtime" };
}

/**
 * Picker options in reading order: the merged Cloud graph first, then Cloud's
 * per-runtime graphs, then the ones runtimes uploaded, each alphabetical.
 */
export function graphChoices(
  graphs: ReadonlyArray<{ graphKey: string; producer: IntentGraphProducer }>,
): GraphChoice[] {
  const rank: Record<GraphChoice["origin"], number> = { cloud: 0, "cloud-source": 1, runtime: 2 };
  return graphs
    .map((graph) => graphChoiceLabel(graph.graphKey, graph.producer))
    .sort((a, b) => rank[a.origin] - rank[b.origin] || a.label.localeCompare(b.label));
}

/**
 * The graph a page shows: the one asked for when it exists, else the merged
 * Cloud graph, else the first choice. Null when there are none.
 */
export function pickGraph(
  choices: readonly GraphChoice[],
  requested: string | null | undefined,
): GraphChoice | null {
  if (requested) {
    const match = choices.find((choice) => choice.graphKey === requested);
    if (match) return match;
  }
  return choices.find((choice) => choice.graphKey === CLOUD_INTENT_GRAPH_KEY) ?? choices[0] ?? null;
}
