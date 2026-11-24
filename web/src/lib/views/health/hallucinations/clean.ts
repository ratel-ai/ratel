import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { HallucinationGroup } from "@/lib/readings/trace-signals/hallucinations/kinds";
import type { ToolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

/**
 * What a window without findings says (pure). `clean`: at least one group was
 * checked and nothing was found, which is good news and reads as such, with
 * one line on what was checked; the agent is called trustworthy only when
 * nothing checked is left open. `unchecked`: no group had anything to read,
 * so nothing is claimed.
 */
export interface CleanResult {
  state: "clean" | "unchecked";
  title: string;
  info: string;
}

export const TRUSTWORTHY = "Your agent is trustworthy";
export const NONE_FOUND = "No hallucinations found";

const CHECKED_AS: Record<HallucinationGroup, string> = {
  tool: "tools",
  input: "inputs",
  completion: "completion claims",
};

const listed = (words: readonly string[]): string =>
  words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

export function cleanResult({
  groups,
  toolNames,
  turns,
  span,
}: {
  groups: ReadonlyArray<{ group: HallucinationGroup; unchecked: string | null }>;
  /** The tool check by name, when that is how tools were checked. */
  toolNames: ToolNameCheck | null;
  turns: number;
  span: string;
}): CleanResult {
  const checked = groups.filter((group) => group.unchecked === null);
  if (checked.length === 0)
    return {
      state: "unchecked",
      title: "Nothing to check yet",
      info: "Your agent's traces carry no finished tool calls, error text or replies.",
    };
  const open = toolNames !== null && toolNames.callsOnWorking < toolNames.calls;
  return {
    state: "clean",
    title: open ? NONE_FOUND : TRUSTWORTHY,
    info: `Checked the ${listed(checked.map(({ group }) => CHECKED_AS[group]))} of ${formatCount(turns)} ${turns === 1 ? "turn" : "turns"} ${span}.`,
  };
}
