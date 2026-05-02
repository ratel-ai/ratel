// control (baseline) — every tool in the expanded pool registered directly
// with the agent. The fat-context floor: this is what an agent looks like
// when nothing is filtering its tool list. Used as the reference point for
// every "Ratel saves N% tokens" claim.

import type { AgentDescriptor, AgentRunInput, ToolSpec } from "../types.js";
import { buildToolBundle, runMeteredLoop, type ToolBundle } from "./_shared.js";

const ID = "control-baseline";

/** Bundle-builder, exported for unit tests. */
export function buildControlBaselineBundle(input: { pool: ToolSpec[] }): ToolBundle {
  return buildToolBundle(input.pool);
}

export const descriptor: AgentDescriptor = {
  id: ID,
  label: "control (baseline)",
  run: async (input: AgentRunInput) => {
    const bundle = buildControlBaselineBundle(input);
    return runMeteredLoop(ID, input, bundle);
  },
};
