import { kindsOf, type StepsView, showsAnnotations } from "@/lib/readings/trace-signals/steps/view";
import type { SessionChat, TrackSegment } from "@/lib/views/session-chat/model";
import type { TaskDetailModel } from "@/lib/views/tasks/model";

/**
 * The `?steps=` presets (typed steps) as the task page and the session replay
 * apply them: which steps show, and which inferred labels sit on them. Pure
 * and browser-safe: the replay applies them in the client.
 */

export const STEPS_PARAM = "steps";

type TaskSteps = Pick<TaskDetailModel, "steps" | "sideSteps" | "flow">;

export interface TaskStepsShown extends TaskSteps {
  /** False in the flow preset: no step marks. */
  annotations: boolean;
}

/** A task's steps, side steps and drawing with only the kinds of the preset; flow also drops the step marks. */
export function taskStepsView(task: TaskSteps, view: StepsView): TaskStepsShown {
  const kinds: readonly string[] = kindsOf(view);
  const annotations = showsAnnotations(view);
  const keep = <T extends TaskSteps["steps"][number]>(steps: readonly T[]): T[] =>
    steps
      .filter((step) => step.kind !== undefined && kinds.includes(step.kind))
      .map((step) => (annotations ? step : { ...step, mark: null }));
  const steps = keep(task.steps);
  const sideSteps = keep(task.sideSteps);
  const kept = new Set([...steps, ...sideSteps].map((step) => step.toolId));
  return {
    steps,
    sideSteps,
    flow: {
      tools: task.flow.tools.filter((tool) => kept.has(tool.toolId)),
      edges: task.flow.edges.filter((edge) => kept.has(edge.a) && kept.has(edge.b)),
    },
    annotations,
  };
}

/** A replay step under a preset: asks and waits always show (they keep the time), searches go with tool calls, the rest by kind. */
export function showsSegment(
  segment: Pick<TrackSegment, "kind" | "publicKind">,
  view: StepsView,
): boolean {
  if (segment.kind === "ask" || segment.kind === "wait") return true;
  if (segment.kind === "search") return view === "all" || view === "tools";
  return (
    segment.publicKind != null && (kindsOf(view) as readonly string[]).includes(segment.publicKind)
  );
}

/**
 * The inferred label on a replay step, or null: a model call's thinking
 * tokens, and the turn's intent and tone on its first user message. None in
 * the flow preset.
 */
export function segmentAnnotation(
  segment: Pick<TrackSegment, "kind" | "stepIndex" | "turnIndex" | "reasoningTokens">,
  view: StepsView,
  chat: {
    segments: readonly Pick<TrackSegment, "kind" | "stepIndex" | "turnIndex">[];
    intents?: SessionChat["intents"];
  },
): string | null {
  if (!showsAnnotations(view)) return null;
  if (segment.kind === "model_call")
    return segment.reasoningTokens
      ? `Thinking · ${segment.reasoningTokens.toLocaleString("en-US")} tokens`
      : null;
  if (segment.kind !== "user_message") return null;
  const first = chat.segments.find(
    (s) => s.kind === "user_message" && s.turnIndex === segment.turnIndex,
  );
  if (first?.stepIndex !== segment.stepIndex) return null;
  const intent = chat.intents?.[segment.turnIndex];
  if (!intent) return null;
  return [intent.topic, intent.sentiment].filter(Boolean).join(" · ") || null;
}

/** The same page with another preset, every other query value kept; the default preset leaves the parameter out. */
export function stepsViewHref(pathname: string, search: string, view: StepsView): string {
  const params = new URLSearchParams(search);
  if (view === "all") params.delete(STEPS_PARAM);
  else params.set(STEPS_PARAM, view);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
