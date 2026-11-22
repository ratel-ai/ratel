import type { PublicStepKind } from "./kind";

export type StepsView = "all" | "tools" | "models" | "intents" | "flow";

const PRESET_KINDS = {
  all: ["user_message", "model_call", "tool_call", "skill", "code", "handoff"],
  tools: ["tool_call", "skill"],
  models: ["model_call"],
  intents: ["user_message"],
  flow: ["model_call", "tool_call", "skill", "code", "handoff"],
} as const satisfies Record<StepsView, readonly PublicStepKind[]>;

/** Parse the steps query parameter. Unknown values use the complete view. */
export function parseStepsView(value: unknown): StepsView {
  switch (value) {
    case "all":
    case "tools":
    case "models":
    case "intents":
    case "flow":
      return value;
    default:
      return "all";
  }
}

/** Return the public step kinds selected by a preset. */
export function kindsOf(view: StepsView): readonly PublicStepKind[] {
  return PRESET_KINDS[view];
}

/** Flow shows execution steps without their inferred labels. */
export function showsAnnotations(view: StepsView): boolean {
  return view !== "flow";
}
