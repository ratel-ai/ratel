import { PIVOT_PRESETS, validateCustomKey } from "./model";

/**
 * Candidate pivot keys (RC-882): the attribute keys of a sample of recent root
 * spans that slice traces well, so a customer need not know the key names.
 * Pure: the sample comes from `sampleRootSpans` (./candidates-query.ts).
 *
 * A good pivot is on many traces (coverage) and splits them into a few groups.
 * A key with one value splits nothing; a key with a new value on (nearly)
 * every trace is an id, not a group. Keys Ratel already reads (`ratel.*`,
 * model content under `gen_ai.*`, trace and span ids) are never offered.
 */

export interface RootSample {
  traceId: string;
  attributes: Record<string, unknown>;
}

export interface PivotCandidate {
  key: string;
  /** Share of the sampled traces that have the key, 0..1. */
  coverage: number;
  /** Sampled traces that have the key. */
  traces: number;
  /** Distinct values in the sample (counted up to {@link DISTINCT_CAP}). */
  distinct: number;
  /** The preset that reads this key, or null. */
  presetId: string | null;
}

export interface RankOptions {
  /** Keys the project already reads: not offered again. */
  configuredKeys?: readonly string[];
  limit?: number;
}

export const DEFAULT_CANDIDATE_LIMIT = 10;
/** A key whose distinct values reach this share of its traces is an id, not a group. */
export const MAX_DISTINCT_RATIO = 0.9;
/** Longer values are content, not a group name. */
export const MAX_VALUE_LENGTH = 200;
const DISTINCT_CAP = 10_000;
const OWNED_PREFIXES = ["ratel.", "gen_ai."];
const ID_KEY = /(^|[._])(trace|span)[._]?id$/i;
const PRESET_BY_KEY = new Map(
  PIVOT_PRESETS.flatMap((preset) => preset.keys.map((key) => [key, preset.id] as const)),
);

/** The candidate keys of the sample, best first. */
export function rankCandidates(
  samples: readonly RootSample[],
  options: RankOptions = {},
): PivotCandidate[] {
  const configured = new Set(options.configuredKeys ?? []);
  const traces = new Set<string>();
  const stats = new Map<string, { traces: Set<string>; values: Set<string> }>();
  for (const sample of samples) {
    traces.add(sample.traceId);
    for (const [key, raw] of Object.entries(sample.attributes)) {
      const value = groupValue(raw);
      if (value === null || configured.has(key) || isOwned(key)) continue;
      const entry = stats.get(key) ?? { traces: new Set<string>(), values: new Set<string>() };
      entry.traces.add(sample.traceId);
      if (entry.values.size < DISTINCT_CAP) entry.values.add(value);
      stats.set(key, entry);
    }
  }
  const candidates: PivotCandidate[] = [];
  for (const [key, entry] of stats) {
    const distinct = entry.values.size;
    if (distinct < 2 || distinct >= entry.traces.size * MAX_DISTINCT_RATIO) continue;
    candidates.push({
      key,
      coverage: entry.traces.size / traces.size,
      traces: entry.traces.size,
      distinct,
      presetId: PRESET_BY_KEY.get(key) ?? null,
    });
  }
  return candidates
    .sort(
      (a, b) => b.coverage - a.coverage || b.distinct - a.distinct || a.key.localeCompare(b.key),
    )
    .slice(0, options.limit ?? DEFAULT_CANDIDATE_LIMIT);
}

/**
 * A key Ratel owns, or one a person could not add as a custom key. A preset
 * key (such as `gen_ai.conversation.id`) is never owned.
 */
function isOwned(key: string): boolean {
  if (PRESET_BY_KEY.has(key)) return false;
  return (
    OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    ID_KEY.test(key) ||
    !validateCustomKey(key).ok
  );
}

/** A scalar value as text, or null when it cannot name a group. */
function groupValue(raw: unknown): string | null {
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= MAX_VALUE_LENGTH ? value : null;
}
