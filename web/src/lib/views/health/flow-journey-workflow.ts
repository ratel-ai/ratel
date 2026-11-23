import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import { FLOW_JOURNEY_OTHER, type FlowJourney } from "@/lib/readings/trace-signals/view";
import {
  JOURNEY_MAX_CALLS,
  JOURNEY_SHOWN_TOOLS,
  type JourneyLayout,
  lastCallReached,
  layoutJourney,
} from "@/lib/views/health/flow-journey-layout";

/**
 * A workflow on the flow map: its steps in their typical order, read as the
 * "A before B" pairs the map's prerequisites filter already knows how to
 * draw. Each step and the next one become one pair, counted off the
 * journey's paths the same way the map counts its own pairs (A's first call
 * before B's first call in a turn), so focusing a workflow hides and shows
 * parts of the same map instead of drawing a second one.
 *
 * A pair no turn on the map holds (a step folded into "other tools", or past
 * the last recorded call) is left out; with none left the map cannot focus.
 */

/** Turns each tool ran in, and turns where one tool's first call came before another's. */
function countOrder(journey: FlowJourney): {
  toolTurns: Map<string, number>;
  before: Map<string, number>;
} {
  const toolTurns = new Map<string, number>();
  const before = new Map<string, number>();
  for (const path of journey.paths) {
    if (path.turns <= 0) continue;
    const firstAt = new Map<string, number>();
    path.tools.forEach((id, i) => {
      if (id !== FLOW_JOURNEY_OTHER && !firstAt.has(id)) firstAt.set(id, i);
    });
    for (const id of firstAt.keys()) toolTurns.set(id, (toolTurns.get(id) ?? 0) + path.turns);
    for (const [b, bAt] of firstAt) {
      for (const [a, aAt] of firstAt) {
        if (a !== b && aAt < bAt)
          before.set(`${a}>${b}`, (before.get(`${a}>${b}`) ?? 0) + path.turns);
      }
    }
  }
  return { toolTurns, before };
}

/** The workflow's consecutive steps as pairs the map can draw, in step order. */
export function workflowRelations(
  journey: FlowJourney | undefined,
  order: readonly string[],
): JourneyPrerequisite[] {
  if (!journey || journey.turns <= 0 || order.length < 2) return [];
  const { toolTurns, before } = countOrder(journey);
  const labels = new Map(journey.tools.map((tool) => [tool.id, tool.label]));
  const label = (id: string) => labels.get(id) ?? id;
  return order.slice(1).flatMap((tool, i): JourneyPrerequisite[] => {
    const first = order[i]!;
    const together = before.get(`${first}>${tool}`) ?? 0;
    const turns = toolTurns.get(tool) ?? 0;
    if (first === tool || together <= 0 || turns <= 0) return [];
    const confidence = together / turns;
    const firstShare = (toolTurns.get(first) ?? 0) / journey.turns;
    return [
      {
        tool,
        toolLabel: label(tool),
        first,
        firstLabel: label(first),
        turns,
        together,
        confidence,
        lift: firstShare > 0 ? confidence / firstShare : 0,
        // Every step of the workflow is drawn at full strength: the focus is the workflow, not the pair.
        tier: "strong",
      },
    ];
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * How far each call column (1-based) must grow so every one of `tools` it
 * holds gets its own chip. The map names only its busiest tools per column
 * and folds the rest into "+N tools"; a workflow's first step is often one of
 * the folded ones in a busy 1st call, and a folded step cannot be lit along
 * the runs, so the focus would start at the 2nd call. Ranks the column the
 * same way the map does (most turns first, then by name).
 */
export function revealColumns(
  journey: FlowJourney | undefined,
  tools: readonly string[],
): Record<number, number> {
  if (!journey || tools.length === 0) return {};
  const wanted = new Set(tools);
  const calls = lastCallReached(journey);
  const out: Record<number, number> = {};
  for (let k = 0; k < calls; k += 1) {
    const counts = new Map<string, number>();
    for (const path of journey.paths) {
      const id = path.tools[k];
      if (id !== undefined && id !== FLOW_JOURNEY_OTHER)
        counts.set(id, (counts.get(id) ?? 0) + path.turns);
    }
    const ranked = [...counts]
      .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
      .map(([id]) => id);
    const deepest = ranked.reduce((at, id, rank) => (wanted.has(id) ? rank : at), -1);
    const grow = deepest + 1 - JOURNEY_SHOWN_TOOLS;
    if (grow > 0) out[k + 1] = grow;
  }
  return out;
}

/**
 * The every-call map a workflow focus is drawn from: as the prerequisites
 * filter lays it out, with the workflow's steps never folded away, so its
 * first step lights in the 1st call column instead of only in the rows of
 * pairs drawn under the map.
 */
export function workflowFocusLayout(
  journey: FlowJourney | undefined,
  order: readonly string[],
): JourneyLayout | null {
  return layoutJourney(journey, {
    depth: JOURNEY_MAX_CALLS,
    showAll: true,
    expanded: revealColumns(journey, order),
  });
}
