import { TASK_COLOR_SLOTS, type TaskColorSlot } from "@ratel/design-system/task-colors";
import type { ChatBand, ChatTurn } from "./model";

/**
 * How the replay draws task bands: one color per task in the order the
 * session meets them (the palette's three hues, then neutral), and the bands
 * that touch a turn. Pure, browser-safe.
 */

/** A color slot per task, in the order the bands first show it. */
export function bandColors(
  bands: readonly Pick<ChatBand, "workflowId">[],
): Map<string, TaskColorSlot> {
  const out = new Map<string, TaskColorSlot>();
  for (const band of bands) {
    if (out.has(band.workflowId) || out.size >= TASK_COLOR_SLOTS.length) continue;
    out.set(band.workflowId, TASK_COLOR_SLOTS[out.size]!);
  }
  return out;
}

/** The bands with at least one step in the turn, each saying whether it began before the turn or runs on after it. */
export function turnBands(
  bands: readonly ChatBand[],
  turn: Pick<ChatTurn, "stepIndexes">,
): { band: ChatBand; fromBefore: boolean; continues: boolean }[] {
  if (turn.stepIndexes.length === 0) return [];
  const first = Math.min(...turn.stepIndexes);
  const last = Math.max(...turn.stepIndexes);
  return bands
    .filter((band) => band.firstStep <= last && band.lastStep >= first)
    .map((band) => ({ band, fromBefore: band.firstStep < first, continues: band.lastStep > last }));
}

/** The band a step sits in, or null. */
export function bandOfStep(bands: readonly ChatBand[], stepIndex: number | null): ChatBand | null {
  if (stepIndex === null) return null;
  return bands.find((band) => band.firstStep <= stepIndex && band.lastStep >= stepIndex) ?? null;
}
