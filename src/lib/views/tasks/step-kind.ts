import { stepFallbackName } from "@/lib/readings/trace-signals/workflows/name";
import { tokenStepKind } from "@/lib/views/tasks/token-kind";

export { tokenStepKind } from "@/lib/views/tasks/token-kind";

/** Keep engine names out of default views. Preserve catalog names for tools and skills. */
export function tokenStepLabel(token: string, names: ReadonlyMap<string, string>): string {
  const kind = tokenStepKind(token);
  if (kind === "model_call") return "Model call";
  if (kind === "code" || kind === "handoff") {
    const name = token.slice(token.indexOf(":") + 1).replace(/[_.]+/g, " ");
    return kind === "handoff" ? `Handoff to ${name}` : name.charAt(0).toUpperCase() + name.slice(1);
  }
  return names.get(token) ?? stepFallbackName(token);
}
