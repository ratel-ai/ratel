import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { ungroundedArgs } from "@/lib/views/eval-gate/replay";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { type Recording, readRecording } from "@/lib/views/eval-gate/scenario";
import type { EvalTool } from "../domain/types";

/**
 * RC-608: what a run's recording gives an eval's spec. Copied onto the eval
 * because raw telemetry expires (30 days) and an eval outlives it.
 */
export interface CapturedSpec {
  systemPrompt: string | null;
  tools: EvalTool[] | null;
  /** The IDs the run's first call passes that its input never shows, by argument name; empty when there are none. */
  context: Record<string, string> | null;
}

/** Each turn's captured spec; a turn whose prompts weren't captured has none. */
export async function loadCapturedSpecs(
  projectId: string,
  turnIds: readonly string[],
  db: EvalDb,
): Promise<Map<string, CapturedSpec>> {
  const out = new Map<string, CapturedSpec>();
  const runs = await loadRuns(projectId, turnIds, db);
  if (runs.size === 0) return out;
  const windows = [...runs.values()].map((run) => ({
    turnId: run.turnId,
    startedAt: new Date(run.startedAt),
    endedAt: new Date(run.endedAt ?? run.startedAt),
    traceIds: run.traceIds ?? [],
  }));
  const calls = await loadModelCalls(projectId, windows, { withPayload: true }, db);
  for (const [turnId, run] of runs) {
    const recording = readRecording(run, calls.get(turnId) ?? []);
    if (recording) out.set(turnId, capturedSpecOf(recording));
  }
  return out;
}

/** The recording's system prompt, tools, and the unseen IDs of its first call keyed by the argument that holds them. */
export function capturedSpecOf(recording: Recording): CapturedSpec {
  const unseen = ungroundedArgs(recording);
  const args = recording.calls[0]?.args ?? {};
  const context: Record<string, string> = {};
  unseen.forEach((value, i) => {
    const key =
      Object.keys(args).find((name) => JSON.stringify(args[name]).includes(value)) ?? `id_${i + 1}`;
    context[key in context ? `${key}_${i + 1}` : key] = value;
  });
  return {
    systemPrompt: recording.system?.trim() ? recording.system : null,
    tools:
      recording.tools.length > 0
        ? recording.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))
        : null,
    context,
  };
}
