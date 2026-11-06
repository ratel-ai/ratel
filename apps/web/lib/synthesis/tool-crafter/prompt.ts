import { toToolJson } from "@/lib/synthesis/tool-crafter/export";
import { changeOf, type SuggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";

/**
 * A prompt the customer pastes into their own coding agent: what the
 * problem is, what Ratel suggests, and what to expect, all from the
 * suggestion's stored facts. Deterministic: the same suggestion gives the
 * same text, so what is copied is what was reviewed. No model writes it.
 */
export function promptFor(view: SuggestionView, name: (id: string) => string = (id) => id): string {
  const tools = view.tools.map(name);
  const lines: string[] = [];
  lines.push(`Ratel suggests a change to this agent's tools: ${view.headline}`);
  lines.push("");
  lines.push("## Problem");
  lines.push(view.plain);
  if (view.why) lines.push(`Evidence: ${view.why}`);
  for (const fact of view.facts) lines.push(`- ${fact.label}: ${fact.value}`);
  if (view.sources.length > 0) {
    lines.push("Tools involved, as the agent declares them today:");
    for (const tool of view.sources) {
      const args = Object.keys(tool.inputSchema?.properties ?? {});
      lines.push(
        `- ${tool.name}${tool.description ? `: ${oneLine(tool.description)}` : ""}${args.length > 0 ? ` (arguments: ${args.join(", ")})` : ""}`,
      );
    }
  } else if (tools.length > 0) {
    lines.push(`Tools involved: ${tools.join(", ")}`);
  }
  if (view.asks.length > 0)
    lines.push(`Seen under the asks: ${view.asks.map((a) => `"${a.text}"`).join(", ")}`);
  lines.push("");
  lines.push("## Suggestion");
  for (const step of changeOf(view, name).theirs) lines.push(`- ${step}`);
  for (const tool of view.crafted) {
    lines.push(`Drafted definition for ${tool.name}:`);
    lines.push("```json");
    lines.push(toToolJson(tool));
    lines.push("```");
  }
  lines.push("");
  lines.push("## Expected effect");
  if (view.effect) lines.push(view.effect);
  if (view.effects.length > 0)
    lines.push(`${capitalize(view.unit)}: ${view.effects.map((c) => c.text).join(", ")}.`);
  if (view.windowEffects.length > 0)
    lines.push(
      `${capitalize(view.windowLabel)}: ${view.windowEffects.map((c) => c.text).join(", ")}.`,
    );
  if (view.replay)
    lines.push(
      `Retrieval replay over labelled searches: ${view.replay.verdict}${view.replay.delta ? ` (${view.replay.delta})` : ""}.`,
    );
  lines.push(
    `Evidence strength: ${view.maturity}, seen ${view.support} ${view.support === 1 ? "time" : "times"} in the window.`,
  );
  return lines.join("\n");
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
};
const capitalize = (text: string): string =>
  text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
