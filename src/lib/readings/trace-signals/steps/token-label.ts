import { stepFallbackName } from "../workflows/name";
import { tokenStepKind } from "./token-kind";

export { tokenStepKind } from "./token-kind";

/** Keep engine names out of default views. Preserve catalog names for tools and skills. */
export function tokenStepLabel(token: string, names: ReadonlyMap<string, string>): string {
  const kind = tokenStepKind(token);
  if (kind === "model_call") return "Model call";
  if (kind === "code" || kind === "handoff") {
    const name = token.slice(token.indexOf(":") + 1).replace(/[_.]+/g, " ");
    return kind === "handoff" ? `Handoff to ${name}` : name.charAt(0).toUpperCase() + name.slice(1);
  }
  return (
    names.get(token) ??
    (kind === "skill" ? names.get(token.slice("skill:".length)) : undefined) ??
    stepFallbackName(token)
  );
}
