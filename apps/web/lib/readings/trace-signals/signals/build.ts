import {
  type EntryStats,
  type EvidenceSample,
  mixOf,
  newestFirst,
} from "@/lib/readings/trace-signals/signals/accumulators";
import { subjectKeyOf } from "@/lib/readings/trace-signals/signals/turn-facts";
import type {
  DetectedSignal,
  SignalEvidenceRef,
  SignalLane,
} from "@/lib/readings/trace-signals/signals/types";
import type { SignalSubjectKind, TurnSourceMix } from "@/lib/readings/trace-signals/view";

/** Small builders every detector shares, so each detector file reads as its rule. */

/** The ingest lanes behind a mix of turns. */
export function laneOf(mix: TurnSourceMix): SignalLane {
  const runtime = mix.declared + mix.inferred;
  if (mix.otlp > 0 && runtime > 0) return "mixed";
  return mix.otlp > 0 ? "otlp" : "runtime";
}

/**
 * A signal's evidence reference: the sampled turns newest first, the total
 * number of supporting turns, and the mix of those turns (the exact mix when
 * the detector knows it, else the sample's).
 */
export function evidenceOf(
  samples: readonly EvidenceSample[],
  totalTurns: number,
  mix?: TurnSourceMix,
): SignalEvidenceRef {
  const picked = newestFirst(samples);
  return {
    turnIds: picked.map((s) => s.turnId),
    traceEventIds: picked.map((s) => s.eventId),
    totalTurns,
    turnSourceMix: mix ?? mixOf(picked),
  };
}

/** The subject fields of a signal about one catalog entry. */
export function entrySubject(
  entry: EntryStats,
): Pick<DetectedSignal, "subjectKind" | "subjectKey" | "subjectIds" | "entryKind"> {
  const subjectKind: SignalSubjectKind = entry.targetType === "skill" ? "skill" : "tool";
  return {
    subjectKind,
    subjectKey: subjectKeyOf(entry.key),
    subjectIds: [entry.id],
    entryKind: entry.targetType,
  };
}

/** Rounds a share or ratio for storage: enough precision for any display. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Entries in a stable order, so detector output never depends on map insertion. */
export function sortedEntries(entries: ReadonlyMap<string, EntryStats>): EntryStats[] {
  return [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
