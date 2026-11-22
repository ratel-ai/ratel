import { type PublicStepKind, stepKindOf } from "@/lib/readings/trace-signals/steps";

/** Read a stored task token through the shared step-kind mapping. */
export function tokenStepKind(token: string): PublicStepKind {
  const separator = token.indexOf(":");
  const prefix = separator < 0 ? "" : token.slice(0, separator);
  if (prefix === "skill") return stepKindOf({ kind: "invoke", targetType: "skill" })!;
  if (prefix === "model") return stepKindOf({ kind: "model_call" })!;
  if (prefix === "code" || prefix === "handoff") return stepKindOf({ kind: prefix })!;
  return stepKindOf({ kind: "invoke", targetType: "tool" })!;
}
