import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import {
  familyInto,
  type JourneyFocus,
  type JourneyLayout,
  toolIdOf,
} from "@/lib/views/health/flow-journey-layout";

/**
 * Parts of the journey to light, picked by stretches of each turn's calls.
 * Each turn counts once per chip and link it lights, however many stretches
 * of it are picked, so a lit link never carries more turns than it has.
 *
 * - A prerequisite (A before B, anywhere earlier) lights each turn from A's
 *   first call to B's, and the calls between them too: those stay in their
 *   columns, as the "via" steps of the pair.
 * - A chain (A, then B, then C, back to back) lights exactly those calls.
 */

type Span = readonly [from: number, to: number];

function focusOfSpans(
  layout: JourneyLayout,
  node: string,
  spansOf: (keys: readonly string[]) => readonly Span[],
): JourneyFocus {
  const nodes = new Map<string, number>();
  const ribbons = new Map<string, number>();
  let turns = 0;
  for (const route of layout.routes) {
    const spans = spansOf(route.keys);
    if (spans.length === 0) continue;
    turns += route.turns;
    const litNodes = new Set<number>();
    const litLinks = new Set<number>();
    for (const [from, to] of spans) {
      for (let i = from; i <= to; i += 1) {
        litNodes.add(i);
        if (i < to) litLinks.add(i);
      }
    }
    for (const i of litNodes)
      nodes.set(route.keys[i], (nodes.get(route.keys[i]) ?? 0) + route.turns);
    for (const i of litLinks) {
      const key = route.keys[i];
      const next = route.keys[i + 1];
      const ribbon = `${key}>${next}#${familyInto(key, next, route.family)}`;
      ribbons.set(ribbon, (ribbons.get(ribbon) ?? 0) + route.turns);
    }
  }
  return { node, turns, nodes, ribbons };
}

/** Where a turn ran `first` and, later, `tool`: from the first call of one to the first call of the other after it. */
function pairSpan(keys: readonly string[], first: string, tool: string): Span | null {
  const from = keys.findIndex((key) => toolIdOf(key) === first);
  const to = from < 0 ? -1 : keys.findIndex((key, i) => i > from && toolIdOf(key) === tool);
  return to < 0 ? null : [from, to];
}

/** What lights for one prerequisite: in every turn where `first` ran and `tool` ran after it, the chips and links from one to the other. */
export function journeyPairFocus(layout: JourneyLayout, first: string, tool: string): JourneyFocus {
  return focusOfSpans(layout, `pair:${first}>${tool}`, (keys) => {
    const span = pairSpan(keys, first, tool);
    return span ? [span] : [];
  });
}

export interface JourneyPrerequisiteFocus {
  focus: JourneyFocus;
  /** Chip key to the relations it is the needing end of, strongest first. */
  needs: ReadonlyMap<string, readonly JourneyPrerequisite[]>;
  /** Chip key to the relations it is the first end of. */
  firsts: ReadonlyMap<string, readonly JourneyPrerequisite[]>;
}

/**
 * Everything the prerequisites view shows: the union of every relation's
 * turns, and which chips are the two ends of which relation. A lit chip that
 * is neither end is a step in between ("via").
 */
export function journeyPrerequisiteFocus(
  layout: JourneyLayout,
  relations: readonly JourneyPrerequisite[],
): JourneyPrerequisiteFocus {
  const needs = new Map<string, JourneyPrerequisite[]>();
  const firsts = new Map<string, JourneyPrerequisite[]>();
  const add = (
    map: Map<string, JourneyPrerequisite[]>,
    key: string,
    relation: JourneyPrerequisite,
  ) => {
    const list = map.get(key) ?? [];
    if (!list.includes(relation)) map.set(key, [...list, relation]);
  };
  const focus = focusOfSpans(layout, "prerequisites", (keys) =>
    relations.flatMap((relation) => {
      const span = pairSpan(keys, relation.first, relation.tool);
      if (!span) return [];
      add(firsts, keys[span[0]], relation);
      add(needs, keys[span[1]], relation);
      return [span];
    }),
  );
  return { focus, needs, firsts };
}

/** What lights for a common chain: each turn's calls that run exactly those tools, back to back. */
export function journeyChainFocus(layout: JourneyLayout, tools: readonly string[]): JourneyFocus {
  return focusOfSpans(layout, `chain:${tools.join(">")}`, (keys) => {
    const spans: Span[] = [];
    for (let i = 0; i + tools.length <= keys.length; i += 1) {
      if (tools.every((id, k) => toolIdOf(keys[i + k]) === id))
        spans.push([i, i + tools.length - 1]);
    }
    return spans;
  });
}
