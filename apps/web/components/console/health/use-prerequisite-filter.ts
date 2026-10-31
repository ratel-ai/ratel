"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type PrerequisiteView,
  prerequisiteView,
} from "@/components/console/health/journey-prerequisites";
import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney } from "@/lib/readings/trace-signals/view";
import { acrossFocus } from "@/lib/views/health/flow-journey-across";
import { compactJourney } from "@/lib/views/health/flow-journey-compact";
import {
  type JourneyPrerequisiteFocus,
  journeyPairFocus,
  journeyPrerequisiteFocus,
} from "@/lib/views/health/flow-journey-focus";
import {
  JOURNEY_MAX_CALLS,
  type JourneyLayout,
  layoutJourney,
} from "@/lib/views/health/flow-journey-layout";
import { workflowFocusLayout } from "@/lib/views/health/flow-journey-workflow";

/**
 * The prerequisites filter's phases:
 *
 * - `full`: the whole map, which folds and unfolds as it scrolls.
 * - `leaving`: on the way to the filter, the chips it drops fade out where
 *   they are, for {@link FILTER_FADE_MS}.
 * - `compact`: only what the filter keeps, packed with no holes
 *   (`compactJourney`). Complete and static: nothing folds, unfolds or
 *   reveals on scroll, and no dropped chip is ever rendered.
 * - `opening`: on the way back to the whole map, the chips and links of pairs
 *   that cross turns (which have no place in it) fade out first.
 *
 * Then the kept chips glide to their places in the whole map and the rest
 * fade in. The filter reads every call a turn made (not only the three the
 * whole map shows at rest), so a pair deep in a turn is never folded away.
 */
export type FilterPhase = "full" | "leaving" | "compact" | "opening";

export const FILTER_FADE_MS = 160;

export interface PrerequisiteFilter {
  phase: FilterPhase;
  /** The packed map, drawn in the `compact` and `opening` phases. */
  compact: JourneyLayout | null;
  /** What the packed map shows: captions, "via" steps, what a pointed chip reads. */
  view: PrerequisiteView | null;
  /** The pairs drawn along the journey: what `leaving` keeps lit while the rest fades. */
  kept: JourneyPrerequisiteFocus | null;
  /** The count each kept chip shows at rest: turns along the journey, uses across turns. */
  counts: ReadonlyMap<string, number>;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Pairs the journey can draw along a turn's calls, and the ones it links directly (they cross turns, or no turn's path holds them). */
export function splitRelations(
  deep: JourneyLayout,
  relations: readonly JourneyPrerequisite[],
): { along: JourneyPrerequisite[]; across: JourneyPrerequisite[] } {
  const along: JourneyPrerequisite[] = [];
  const across: JourneyPrerequisite[] = [];
  for (const relation of relations) {
    const onPaths =
      !relation.crossTurn && journeyPairFocus(deep, relation.first, relation.tool).turns > 0;
    (onPaths ? along : across).push(relation);
  }
  return { along, across };
}

export function usePrerequisiteFilter(
  journey: FlowJourney,
  filtered: boolean,
  relations: readonly JourneyPrerequisite[],
  current: string | null,
  /** Tools that must keep their own chips (a focused workflow's steps), never folded into "+N tools". */
  reveal: readonly string[] = [],
): PrerequisiteFilter {
  const on = filtered && relations.length > 0;
  const revealKey = reveal.join(" ");
  const deep = useMemo(() => {
    if (relations.length === 0) return null;
    const tools = revealKey ? revealKey.split(" ") : [];
    return tools.length > 0
      ? workflowFocusLayout(journey, tools)
      : layoutJourney(journey, { depth: JOURNEY_MAX_CALLS, showAll: true });
  }, [journey, relations.length, revealKey]);
  const split = useMemo(() => (deep ? splitRelations(deep, relations) : null), [deep, relations]);
  const kept = useMemo(
    () => (deep && split ? journeyPrerequisiteFocus(deep, split.along) : null),
    [deep, split],
  );
  const compact = useMemo(
    () =>
      deep && kept && split
        ? compactJourney(deep, kept.focus, {
            relations: split.across,
            tools: journey.tools,
            windowMinutes: journey.prerequisites
              ? Math.round(journey.prerequisites.windowMs / 60_000)
              : null,
          })
        : null,
    [deep, kept, split, journey],
  );
  const crossing = (compact?.links?.length ?? 0) > 0;

  const [phase, setPhase] = useState<FilterPhase>(on ? "compact" : "full");
  const [was, setWas] = useState(on);
  // Adjusting to the switch during render (not in an effect), so the frame after a
  // switch is already the new phase: nothing the filter drops paints in between.
  if (was !== on) {
    setWas(on);
    const still = prefersReducedMotion();
    setPhase(on ? (still ? "compact" : "leaving") : still || !crossing ? "full" : "opening");
  }
  useEffect(() => {
    if (phase !== "leaving" && phase !== "opening") return;
    const timer = setTimeout(
      () => setPhase(phase === "leaving" ? "compact" : "full"),
      FILTER_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [phase]);

  const view = useMemo(
    () =>
      (phase === "compact" || phase === "opening") && deep && kept && split
        ? prerequisiteView(deep, split.along, kept, current, split.across)
        : null,
    [phase, deep, kept, split, current],
  );
  const counts = useMemo(() => {
    const out = new Map(kept?.focus.nodes ?? []);
    for (const [key, n] of acrossFocus(split?.across ?? []).nodes) out.set(key, n);
    return out;
  }, [kept, split]);
  return { phase, compact, view, kept, counts };
}
