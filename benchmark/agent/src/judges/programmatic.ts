// Programmatic judge: checks the *effective* tool-call trace against the
// scenario's `gold_tools` set. "Effective" means `invoke_tool({toolId: X})`
// counts as a call to X (the gateway is unwrapped) and `search_tools` is
// dropped. Without this unwrapping, the ratel arm — whose whole point is to
// invoke tools through the gateway — would fail every scenario.
//
// Per ADR-0006 the verdict is selection-only: pass iff at least one gold id
// shows up in the effective trace. Argument-level checks were deliberately
// dropped because the v0.1.1 corpora (MetaTool, ToolRet) ship gold tool ids
// only — no gold trace, no canned responses.

import type { ProgrammaticVerdict } from "../types.js";

export interface ProgrammaticDiff {
  verdict: ProgrammaticVerdict;
  /** Gold ids that the agent failed to invoke. */
  missing_gold: string[];
  /** Tool ids the agent invoked that aren't in gold. */
  extra_calls: string[];
}

export function judgeProgrammatic(
  goldTools: string[],
  effectiveToolIds: string[],
): ProgrammaticDiff {
  if (goldTools.length === 0) {
    return { verdict: "n/a", missing_gold: [], extra_calls: [] };
  }
  const observed = new Set(effectiveToolIds);
  const goldSet = new Set(goldTools);

  const missing: string[] = [];
  for (const id of goldSet) {
    if (!observed.has(id)) missing.push(id);
  }
  const extra: string[] = [];
  for (const id of observed) {
    if (!goldSet.has(id)) extra.push(id);
  }
  // Selection-only: pass iff intersection is non-empty.
  const intersected = goldSet.size - missing.length;
  return {
    verdict: intersected > 0 ? "pass" : "fail",
    missing_gold: missing,
    extra_calls: extra,
  };
}
