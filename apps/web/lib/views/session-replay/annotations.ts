import type { Composition } from "./composition";
import type { SessionTimeline, TimelineStep } from "./timeline";

/**
 * Why each tool choice in a session was good or bad (RC-144), as codes and
 * ids: `{step: 7, picked: "search_docs", better: "get_trace", reason:
 * "scored_higher_not_loaded"}`. The view puts them in words. Sources: the
 * turn's searches (hit ids in rank order), the model call before the pick
 * (which tools it loaded), the match-quality label of the search's query
 * (resolved by `annotations-load.ts`, by search step) and the calibration
 * mismatches of the session's searches.
 */

export type AnnotationReason =
  | "top_ranked"
  | "label_agrees"
  | "scored_higher"
  | "scored_higher_not_loaded"
  | "label_disagrees"
  | "not_offered"
  | "failed"
  | "calibration_mismatch";

export interface Annotation {
  /** The timeline step (1-based) the annotation is about. */
  step: number;
  turnIndex: number;
  picked: string | null;
  better: string | null;
  reason: AnnotationReason;
  verdict: "good" | "bad";
  /** The pick's 1-based rank in the search that listed it. */
  rank: number | null;
  /** The calibration selection a mismatch was recorded on. */
  selectionId: string | null;
}

export interface CalibrationMismatch {
  /** The search step it belongs to. */
  step: number;
  selectionId: string | null;
}

export interface AnnotationInput {
  timeline: SessionTimeline;
  /** By model call event id. */
  compositions: ReadonlyMap<string, Composition>;
  /** The labelled tool (entry id) by search step. */
  labels: ReadonlyMap<number, string>;
  calibrationMismatches: readonly CalibrationMismatch[];
}

export interface SessionAnnotations {
  annotations: Annotation[];
  /** Per model call step: tools the session needed (a better pick) that the call did not load. */
  missingTools: { step: number; tools: string[] }[];
}

type SearchStep = Extract<TimelineStep, { kind: "search" }>;
type ToolCallStep = Extract<TimelineStep, { kind: "tool_call" }>;
type ModelCallStep = Extract<TimelineStep, { kind: "model_call" }>;

const NEEDS_LOADING: ReadonlySet<AnnotationReason> = new Set([
  "scored_higher_not_loaded",
  "label_disagrees",
]);

export function annotateSession(input: AnnotationInput): SessionAnnotations {
  const annotations: Annotation[] = [];
  const missing = new Map<number, Set<string>>();
  const searches: SearchStep[] = [];
  let lastCall: ModelCallStep | null = null;
  let turnId: string | null = null;
  for (const step of input.timeline.steps) {
    if (step.turnId !== turnId) {
      turnId = step.turnId;
      searches.length = 0;
      lastCall = null;
    }
    if (step.kind === "model_call") lastCall = step;
    if (step.kind === "search") searches.push(step);
    if (step.kind !== "tool_call" || !step.targetId) continue;
    const loaded = lastCall
      ? (input.compositions.get(lastCall.eventId)?.loadedTools.map((tool) => tool.name) ?? [])
      : [];
    for (const annotation of annotatePick(step, step.targetId, searches, loaded, input.labels)) {
      annotations.push(annotation);
      if (
        lastCall &&
        annotation.better &&
        NEEDS_LOADING.has(annotation.reason) &&
        loaded.length > 0 &&
        !loaded.includes(annotation.better)
      ) {
        missing.set(
          lastCall.index,
          (missing.get(lastCall.index) ?? new Set()).add(annotation.better),
        );
      }
    }
  }
  const byStep = new Map(input.timeline.steps.map((step) => [step.index, step]));
  for (const mismatch of input.calibrationMismatches) {
    const step = byStep.get(mismatch.step);
    if (!step) continue;
    annotations.push({
      step: step.index,
      turnIndex: step.turnIndex,
      picked: null,
      better: null,
      reason: "calibration_mismatch",
      verdict: "bad",
      rank: null,
      selectionId: mismatch.selectionId,
    });
  }
  annotations.sort((a, b) => a.step - b.step);
  return {
    annotations,
    missingTools: [...missing.entries()]
      .sort(([a], [b]) => a - b)
      .map(([step, tools]) => ({ step, tools: [...tools].sort() })),
  };
}

/** One pick's annotations: its rank against the searches before it, its label, and whether it failed. */
function annotatePick(
  step: ToolCallStep,
  picked: string,
  searches: readonly SearchStep[],
  loaded: readonly string[],
  labels: ReadonlyMap<number, string>,
): Annotation[] {
  const base = { step: step.index, turnIndex: step.turnIndex, picked, selectionId: null };
  const out: Annotation[] = [];
  const listing = [...searches].reverse().find((search) => search.hitIds.includes(picked)) ?? null;
  if (listing) {
    const rank = listing.hitIds.indexOf(picked) + 1;
    const top = listing.hitIds[0]!;
    if (rank === 1)
      out.push({ ...base, better: null, reason: "top_ranked", verdict: "good", rank });
    else {
      const notLoaded = loaded.length > 0 && !loaded.includes(top);
      out.push({
        ...base,
        better: top,
        reason: notLoaded ? "scored_higher_not_loaded" : "scored_higher",
        verdict: "bad",
        rank,
      });
    }
  } else if (searches.length > 0) {
    out.push({
      ...base,
      better: searches[searches.length - 1]!.hitIds[0] ?? null,
      reason: "not_offered",
      verdict: "bad",
      rank: null,
    });
  }
  const labelled = listing ?? searches[searches.length - 1];
  const label = labelled ? labels.get(labelled.index) : undefined;
  if (label !== undefined) {
    const rank = listing ? listing.hitIds.indexOf(picked) + 1 : null;
    out.push(
      label === picked
        ? { ...base, better: null, reason: "label_agrees", verdict: "good", rank }
        : { ...base, better: label, reason: "label_disagrees", verdict: "bad", rank },
    );
  }
  if (step.outcome === "error")
    out.push({ ...base, better: null, reason: "failed", verdict: "bad", rank: null });
  return out;
}
