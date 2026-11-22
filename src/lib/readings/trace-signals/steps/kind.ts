export type PublicStepKind =
  | "user_message"
  | "model_call"
  | "tool_call"
  | "skill"
  | "code"
  | "handoff";

interface StepKindInput {
  kind: string;
  targetType?: string | null;
}

/** Map stored steps to public kinds. Return null for legacy markers without a public kind. */
export function stepKindOf(step: StepKindInput): PublicStepKind | null {
  switch (step.kind) {
    case "invoke":
      return step.targetType === "skill" ? "skill" : "tool_call";
    case "user_message":
    case "model_call":
    case "code":
    case "handoff":
      return step.kind;
    default:
      return null;
  }
}
