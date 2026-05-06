// control (oracle) — only the gold tools registered with the agent. The
// "model can't do better than this" upper bound: distractors are erased
// entirely, so any failures here are about the model itself rather than
// tool-selection noise. Pulls gold specs from `scenario.candidate_pool`
// (which the ingest contract guarantees carries them); the expanded pool is
// irrelevant because oracle never sees distractors.

import type { AgentDescriptor, AgentRunInput, Scenario } from "../types.js";
import { buildToolBundle, runMeteredLoop, type ToolBundle } from "./_shared.js";

const ID = "control-oracle";

/** Bundle-builder, exported for unit tests. */
export function buildControlOracleBundle(input: {
  scenario: Pick<Scenario, "candidate_pool" | "gold_tools">;
}): ToolBundle {
  const goldSet = new Set(input.scenario.gold_tools);
  const goldSpecs = input.scenario.candidate_pool.filter((spec) => goldSet.has(spec.id));
  return buildToolBundle(goldSpecs);
}

export const descriptor: AgentDescriptor = {
  id: ID,
  label: "control (oracle)",
  // Oracle only sees gold tools; the expanded pool is irrelevant. The runner
  // skips the `--pool-sizes` loop and writes `pool_size: null` in the row.
  poolSizeAgnostic: true,
  run: async (input: AgentRunInput) => {
    const bundle = buildControlOracleBundle(input);
    return runMeteredLoop(ID, input, bundle);
  },
};
