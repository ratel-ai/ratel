// Programmatic judge: checks the *effective* tool-call trace against the gold
// trace. "Effective" means `invoke_tool({toolId: X})` counts as a call to X
// (the gateway is unwrapped) and `search_tools` is dropped. Without this
// unwrapping, the hybrid arm — whose whole point is to invoke tools through
// the gateway — would fail every scenario.

import type { GoldCall, ProgrammaticVerdict } from "../types.js";

export interface ProgrammaticDiff {
  verdict: ProgrammaticVerdict;
  missing_gold: string[];
  extra_calls: string[];
}

export function judgeProgrammatic(
  goldTrace: GoldCall[],
  effectiveToolIds: string[],
): ProgrammaticDiff {
  if (goldTrace.length === 0) {
    return { verdict: "n/a", missing_gold: [], extra_calls: [] };
  }
  const observed = new Set(effectiveToolIds);
  const goldIds = new Set(goldTrace.map((g) => g.tool_id));

  const missing: string[] = [];
  for (const id of goldIds) {
    if (!observed.has(id)) missing.push(id);
  }
  const extra: string[] = [];
  for (const id of observed) {
    if (!goldIds.has(id)) extra.push(id);
  }
  return {
    verdict: missing.length === 0 ? "pass" : "fail",
    missing_gold: missing,
    extra_calls: extra,
  };
}
