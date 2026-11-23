import type { HallucinationGroup } from "@/lib/readings/trace-signals/hallucinations/kinds";
import type { ToolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

/**
 * What a window without findings says (pure). `clean`: at least one group was
 * checked and nothing was found, which is good news and reads as such; the
 * agent is called trustworthy only when nothing checked is left open.
 * `unchecked`: no group had anything to read, so nothing is claimed.
 */
export interface CleanResult {
  state: "clean" | "unchecked";
  title: string;
}

export const TRUSTWORTHY = "Your agent is trustworthy";
export const NONE_FOUND = "No hallucinations found";

export function cleanResult({
  groups,
  toolNames,
}: {
  groups: ReadonlyArray<{ group: HallucinationGroup; unchecked: string | null }>;
  /** The tool check by name, when that is how tools were checked. */
  toolNames: ToolNameCheck | null;
}): CleanResult {
  if (groups.every((group) => group.unchecked !== null))
    return { state: "unchecked", title: "Nothing to check yet" };
  const open = toolNames !== null && toolNames.callsOnWorking < toolNames.calls;
  return { state: "clean", title: open ? NONE_FOUND : TRUSTWORTHY };
}
