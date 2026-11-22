import type { ToolAnswerSource } from "@/lib/views/eval-gate/types";
import { differStep, replaySteps } from "./domain/steps";
import type { Eval, EvalResult } from "./domain/types";
import { REASON_TEXT, SOURCE_RULES } from "./test-view";

/**
 * RC-642: a simulated run as frames a person steps through: the system
 * prompt, the message, then each step of the transcript. `step` is the
 * transcript index the step actions take. Pure.
 */

export type ReplayFrame =
  | { kind: "system"; text: string | null; generated: boolean }
  | { kind: "message"; text: string; generated: boolean }
  | { kind: "assistant"; step: number; text: string; calls: { name: string; args: string }[] }
  | {
      kind: "tool";
      step: number;
      tool: string;
      args: string;
      answer: string;
      isError: boolean;
      source: ToolAnswerSource | null;
      rule: string | null;
      reason: string | null;
    };

/** Frames before the transcript's steps: the system prompt and the message. */
export const LEAD_FRAMES = 2;

export interface ReplayModel {
  frames: ReplayFrame[];
  /** The frame where this run starts to differ from the previous run; null when it does not, or there is none. */
  differAt: number | null;
  /** The previous run's frame at each index, for "Last run". */
  previousFrames: ReplayFrame[] | null;
}

/** Null when the result kept no text (expired, or from before RC-641). */
export function replayModel(
  item: Pick<Eval, "systemPrompt" | "message" | "generated">,
  result: Pick<EvalResult, "transcript" | "toolAnswers">,
  previous: Pick<EvalResult, "transcript" | "toolAnswers"> | null = null,
): ReplayModel | null {
  if (!result.transcript) return null;
  const frames = framesOf(item, result);
  const previousFrames = previous?.transcript ? framesOf(item, previous) : null;
  const differ = previous?.transcript
    ? differStep(
        replaySteps(previous.transcript, previous.toolAnswers),
        replaySteps(result.transcript, result.toolAnswers),
      )
    : null;
  return { frames, differAt: differ === null ? null : differ + LEAD_FRAMES, previousFrames };
}

/** One frame's short label for the step list. */
export function frameLabel(frame: ReplayFrame): string {
  switch (frame.kind) {
    case "system":
      return "System prompt";
    case "message":
      return "Message";
    case "assistant":
      return frame.calls.length > 0
        ? `Agent calls ${frame.calls.map((call) => call.name).join(", ")}`
        : "Agent replies";
    case "tool":
      return `${frame.tool} answers`;
  }
}

function framesOf(
  item: Pick<Eval, "systemPrompt" | "message" | "generated">,
  result: Pick<EvalResult, "transcript" | "toolAnswers">,
): ReplayFrame[] {
  const generated = new Set(item.generated ?? []);
  const lead: ReplayFrame[] = [
    { kind: "system", text: item.systemPrompt ?? null, generated: generated.has("systemPrompt") },
    { kind: "message", text: item.message, generated: generated.has("message") },
  ];
  return [
    ...lead,
    ...replaySteps(result.transcript!, result.toolAnswers).map(
      (step): ReplayFrame =>
        step.role === "assistant"
          ? {
              kind: "assistant",
              step: step.index,
              text: step.text,
              calls: step.calls.map((call) => ({
                name: call.name,
                args: JSON.stringify(call.args),
              })),
            }
          : {
              kind: "tool",
              step: step.index,
              tool: step.tool,
              args: JSON.stringify(step.args, null, 2),
              answer: prettyText(step.content),
              isError: step.isError,
              source: step.source,
              rule: step.source ? SOURCE_RULES[step.source] : null,
              reason: step.reason
                ? [REASON_TEXT[step.reason], step.why ? `Why: ${step.why}` : ""]
                    .filter(Boolean)
                    .join(" ")
                : null,
            },
    ),
  ];
}

function prettyText(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
