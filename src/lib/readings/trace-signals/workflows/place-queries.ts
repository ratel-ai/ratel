import { getDb } from "@/lib/platform/db/client";
import {
  type SegmentPlacement,
  writeTaskSegments,
} from "@/lib/readings/trace-signals/segments/write";

/**
 * Writes a signal run's placement: the task segments of every session with a
 * closed run in the run's window (`segments/write.ts`), and each run's first
 * task to `trace_turns.workflow_id`, so every page that lists a task's runs,
 * and every job after the signal run (names, topics, self-corrections, Tool
 * craft's reading), reads the same answer.
 *
 * Idempotent: only rows whose value changes are written, so the same reading
 * run twice writes nothing new.
 */

export type PlacementDb = Pick<ReturnType<typeof getDb>, "transaction">;

export interface PlacementWrite {
  window: { start: Date; end: Date };
  /** The reading's tasks and weights: the affected sessions are cut and placed again. */
  segments: SegmentPlacement;
}

export interface PlacementWriteResult {
  /** Runs placed in a task by this reading. */
  placed: number;
  /** Rows whose task was written, and rows whose stale task was cleared. */
  set: number;
  cleared: number;
}

export async function writeTaskPlacement(
  projectId: string,
  input: PlacementWrite,
  db: PlacementDb = getDb(),
): Promise<PlacementWriteResult> {
  return writeTaskSegments(projectId, input.window, input.segments, db);
}
