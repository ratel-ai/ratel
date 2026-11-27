import { formatCount } from "@/lib/readings/trace-signals/figures";
import type { HealthPageModel } from "@/lib/readings/trace-signals/view";

/**
 * The one rule for whether Agent health is open (RTL-367): a reading has been
 * computed, and it counts at least the turns its floor asks for. Agent health
 * shows its issues by it, and the Overview lists them in Needs attention by
 * it, so the Overview never points at a problem Agent health cannot open yet.
 *
 * The floor is the model's own: the usual 50 turns, or the low-confidence
 * floor when `toolRunInsights` lets a reading show early (RC-828). Pure.
 */

/** What the rule reads: the reading's turns and floor, and whether there is a reading. */
export type HealthUnlockReading = Pick<HealthPageModel, "turns" | "floor" | "computedAt">;

/** Open, or locked with how far the turns are. */
export type HealthUnlock =
  | { unlocked: true }
  | {
      unlocked: false;
      /** Turns counted in the window so far. */
      turns: number;
      /** Turns Agent health opens at. */
      floor: number;
    };

export type HealthLock = Extract<HealthUnlock, { unlocked: false }>;

export function healthUnlock(reading: HealthUnlockReading): HealthUnlock {
  const turns = Math.max(0, reading.turns);
  if (reading.computedAt !== null && turns > 0 && turns >= reading.floor) return { unlocked: true };
  return { unlocked: false, turns, floor: reading.floor };
}

export function isHealthUnlocked(reading: HealthUnlockReading): boolean {
  return healthUnlock(reading).unlocked;
}

/**
 * The progress line in place of what Agent health would list: "Agent health
 * unlocks at 50 turns · 36/50". With enough turns and no reading yet, the
 * first reading is on its way instead.
 */
export function healthUnlockLine({ turns, floor }: HealthLock): string {
  if (turns >= floor) return "Agent health is building its first reading";
  return `Agent health unlocks at ${formatCount(floor)} turns · ${formatCount(turns)}/${formatCount(floor)}`;
}
