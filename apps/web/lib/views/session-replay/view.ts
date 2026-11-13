import type { Annotation } from "./annotations";
import type { SessionLens } from "./annotations-load";
import { type CompositionGap, LENS_PARTS, type LensPart } from "./composition";
import type { Coverage, SessionTimeline, StepMark, TimelineStep } from "./timeline";

/**
 * What the session page draws (RC-144): one row per timeline step with its
 * title, its context bar (model calls), its markers and its decision chips in
 * words, plus the coverage banner. Built from ids, counts and codes: no
 * message, argument or query text reaches it.
 */

export const PART_LABEL: Record<LensPart, string> = {
  system: "System prompt",
  skills: "Skills",
  memory: "Memory",
  tools_used: "Tools used",
  tools_unused: "Tools unused",
  history: "History",
  tool_results: "Tool results",
  user_input: "User input",
};

export type MarkerKind = "unused_tool" | "missing_tool" | "bloat_start";

export interface BarSegment {
  part: LensPart;
  label: string;
  tokens: number;
  share: number;
}

export interface ViewRow {
  index: number;
  kind: TimelineStep["kind"];
  turnIndex: number;
  title: string;
  detail: string | null;
  at: string;
  coverage: Coverage;
  marks: { code: StepMark; label: string }[];
  /** The stacked context bar, on model calls only. */
  bar: { total: number; segments: BarSegment[] } | null;
  markers: { kind: MarkerKind; text: string }[];
  chips: { tone: Annotation["verdict"]; text: string }[];
  /** The model call whose context this row sits in: itself, or the latest call before it in its turn. */
  lensStep: number | null;
}

export interface SessionView {
  sessionId: string;
  rows: ViewRow[];
  totals: {
    turns: number;
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    costUsd: number;
  };
  coverage: { counts: Record<Coverage, number>; text: string; tone: "info" | "warning" };
  /** What the lens cannot split or know, in words. */
  gaps: string[];
}

const MARK_LABEL: Record<StepMark, string> = {
  retry: "Retry",
  loop: "Loop",
  abandoned: "Abandoned",
};
const OUTCOME_LABEL: Record<string, string> = { ok: "ok", error: "failed", unknown: "no end seen" };
const GAP_TEXT: Record<CompositionGap | "no_window_size", string> = {
  system_in_skills: "The base system prompt is counted in skills where the call kept no text.",
  tool_results_in_history: "Tool results are counted in history where the call kept no text.",
  no_window_size: "The context window size is not known.",
};
const NAMES_SHOWN = 5;
const BLOAT_TEXT =
  "Bloat starts here: history and tool results are more than half the input, which has doubled since the first call.";

export function buildSessionView(timeline: SessionTimeline, lens: SessionLens): SessionView {
  const compositionAt = new Map(lens.calls.map((call) => [call.step, call.composition]));
  const markersAt = new Map<number, ViewRow["markers"]>();
  const addMarker = (step: number, kind: MarkerKind, text: string) =>
    markersAt.set(step, [...(markersAt.get(step) ?? []), { kind, text }]);
  for (const { step, tools } of lens.unusedTools)
    addMarker(step, "unused_tool", `Loaded and never used: ${listText(tools)}.`);
  for (const { step, tools } of lens.missingTools)
    addMarker(step, "missing_tool", `Needed and not loaded: ${listText(tools)}.`);
  if (lens.bloatStartStep !== null) addMarker(lens.bloatStartStep, "bloat_start", BLOAT_TEXT);
  const chipsAt = new Map<number, ViewRow["chips"]>();
  for (const annotation of lens.annotations)
    chipsAt.set(annotation.step, [
      ...(chipsAt.get(annotation.step) ?? []),
      { tone: annotation.verdict, text: chipText(annotation) },
    ]);

  let lensStep: number | null = null;
  let turnId: string | null = null;
  const rows = timeline.steps.map((step): ViewRow => {
    if (step.turnId !== turnId) {
      turnId = step.turnId;
      lensStep = null;
    }
    if (step.kind === "model_call") lensStep = step.index;
    const composition = compositionAt.get(step.index);
    return {
      index: step.index,
      kind: step.kind,
      turnIndex: step.turnIndex,
      title: stepTitle(step),
      detail: stepDetail(step),
      at: step.at,
      coverage: step.coverage,
      marks: step.marks.map((code) => ({ code, label: MARK_LABEL[code] })),
      bar: composition ? barOf(composition.parts, composition.inputTokens) : null,
      markers: markersAt.get(step.index) ?? [],
      chips: chipsAt.get(step.index) ?? [],
      lensStep: step.kind === "turn" ? null : lensStep,
    };
  });

  const calls = timeline.steps.filter((step) => step.kind === "model_call");
  const gapCodes = new Set<CompositionGap | "no_window_size">();
  for (const call of lens.calls) for (const gap of call.composition.gaps) gapCodes.add(gap);
  for (const gap of lens.gaps) gapCodes.add(gap);
  return {
    sessionId: timeline.sessionId,
    rows,
    totals: {
      turns: timeline.turnCount,
      modelCalls: calls.length,
      toolCalls: timeline.steps.filter((step) => step.kind === "tool_call").length,
      inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
      costUsd: Math.round(calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) * 1e6) / 1e6,
    },
    coverage: {
      counts: timeline.coverage,
      text: coverageText(timeline.coverage),
      tone: timeline.coverage.expired > 0 ? "warning" : "info",
    },
    gaps: (["system_in_skills", "tool_results_in_history", "no_window_size"] as const)
      .filter((gap) => gapCodes.has(gap))
      .map((gap) => GAP_TEXT[gap]),
  };
}

/** One annotation as a sentence. */
export function chipText(annotation: Annotation): string {
  const at = `At step ${annotation.step}`;
  const picked = annotation.picked ?? "a tool";
  const better = annotation.better ?? "another tool";
  switch (annotation.reason) {
    case "top_ranked":
      return `${at} the agent picked ${picked}, the top search result.`;
    case "label_agrees":
      return `${at} the agent picked ${picked}, the tool labelled right for this request.`;
    case "scored_higher":
      return `${at} the agent picked ${picked}. ${better} scored higher.`;
    case "scored_higher_not_loaded":
      return `${at} the agent picked ${picked}. ${better} scored higher but was not loaded.`;
    case "label_disagrees":
      return `${at} the agent picked ${picked}. The label for this request is ${better}.`;
    case "not_offered":
      return annotation.better
        ? `${at} the agent picked ${picked}. No search listed it. The last search ranked ${better} first.`
        : `${at} the agent picked ${picked}. No search listed it.`;
    case "failed":
      return `${at} the call to ${picked} failed.`;
    case "calibration_mismatch":
      return `${at} the calibration arms ranked the results in a different order.`;
  }
}

export function coverageText(counts: Record<Coverage, number>): string {
  const total = counts.content + counts.tokens_only + counts.expired;
  const has = (n: number) => (n === 1 ? "has" : "have");
  return `Of ${total} ${total === 1 ? "step" : "steps"}, ${counts.content} ${has(counts.content)} content, ${counts.tokens_only} ${has(counts.tokens_only)} token counts only and ${counts.expired} expired.`;
}

export function sessionReplayHref(projectId: string, sessionId: string): string {
  return `/project/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function stepTitle(step: TimelineStep): string {
  switch (step.kind) {
    case "turn":
      return `Turn ${step.turnIndex}`;
    case "model_call":
      return step.model ? `Model call · ${step.model}` : "Model call";
    case "search":
      return `Search · ${step.hitCount ?? step.hitIds.length} ${(step.hitCount ?? step.hitIds.length) === 1 ? "hit" : "hits"}`;
    case "tool_call":
      return `${step.targetId ?? "Unknown tool"} · ${OUTCOME_LABEL[step.outcome ?? "unknown"] ?? step.outcome}`;
  }
}

function stepDetail(step: TimelineStep): string | null {
  const n = (value: number) => value.toLocaleString("en-US");
  if (step.kind === "model_call") {
    const parts = [
      step.inputTokens !== null ? `${n(step.inputTokens)} in` : null,
      step.outputTokens !== null ? `${n(step.outputTokens)} out` : null,
      step.latencyMs !== null ? `${n(step.latencyMs)} ms` : null,
      step.costUsd !== null ? `$${step.costUsd.toFixed(4)}` : null,
    ];
    return parts.filter(Boolean).join(" · ") || null;
  }
  if (step.kind === "search")
    return step.hitIds.length > 0 ? `Top: ${step.hitIds.slice(0, 3).join(", ")}` : null;
  if (step.kind === "tool_call") return step.tookMs !== null ? `${n(step.tookMs)} ms` : null;
  return step.endedBy ? `Ended by ${step.endedBy.replace(/_/g, " ")}` : null;
}

function barOf(parts: Record<LensPart, number>, total: number): ViewRow["bar"] {
  const sum = LENS_PARTS.reduce((acc, part) => acc + parts[part], 0);
  const segments = LENS_PARTS.filter((part) => parts[part] > 0).map((part) => ({
    part,
    label: PART_LABEL[part],
    tokens: parts[part],
    share: sum > 0 ? parts[part] / sum : 0,
  }));
  return { total, segments };
}

function listText(names: readonly string[]): string {
  if (names.length > NAMES_SHOWN)
    return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${names.length - NAMES_SHOWN} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
