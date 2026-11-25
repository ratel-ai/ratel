import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { LowConfidence } from "@/lib/readings/trace-signals/view";

/** The low-confidence warning (RC-828): "Low confidence: read from 24 turns. It firms up at 50." */
export function lowConfidenceCopy(mark: LowConfidence): string {
  return `Low confidence: read from ${formatCount(mark.turns)} ${mark.turns === 1 ? "turn" : "turns"}. It firms up at ${formatCount(mark.firmsUpAt)}.`;
}
