// Tool-pool helpers. Mode (c) needs every scenario to be evaluated against the
// same target catalog size — but our corpora ship per-scenario `candidate_pool`
// containing only the gold tools. We synthesize the rest of the catalog at
// runtime by pooling tools from other scenarios as distractors, deterministically
// seeded by `(scenario.id, seed)` so re-runs are reproducible.
//
// This mirrors the Rust retrieval runner's approach
// (`benchmark/retrieval/src/runner.rs`) — gold first, then deterministically
// shuffled distractors — but uses an independent JS PRNG, so the actual orderings
// differ between layers (each layer is internally deterministic).

import type { Scenario, ToolSpec } from "./types.js";

/**
 * Global tool universe across the full corpus. Walks every scenario's
 * `candidate_pool`, dedupes by id, preserves first-seen spec on collision.
 *
 * Insertion order is stable across runs because scenario order is stable
 * (the corpus JSONL is loaded line-by-line, and the Rust ingest sorts ids).
 */
export function buildToolUniverse(scenarios: Scenario[]): ToolSpec[] {
  const seen = new Set<string>();
  const out: ToolSpec[] = [];
  for (const s of scenarios) {
    for (const t of s.candidate_pool) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/**
 * Build the per-scenario tool pool the agent (or BM25 ranker) sees. Returns
 * `[...goldTools, ...shuffledDistractors]` truncated to `targetSize`. Gold tools
 * are *always* present even when `targetSize < gold.length` — selection metrics
 * are meaningless without them.
 *
 * `seed` is mixed with `scenario.id` to vary distractor order per scenario while
 * staying deterministic for the same `(id, seed)` pair.
 */
export function expandPool(
  scenario: Scenario,
  universe: ToolSpec[],
  targetSize: number,
  seed: number,
): ToolSpec[] {
  const goldIds = new Set(scenario.gold_tools);
  const goldSpecs = pickGoldSpecs(scenario);
  const distractors = universe.filter((t) => !goldIds.has(t.id));

  shuffleInPlace(distractors, mixSeed(scenario.id, seed));

  const slotsForDistractors = Math.max(0, targetSize - goldSpecs.length);
  return [...goldSpecs, ...distractors.slice(0, slotsForDistractors)];
}

function pickGoldSpecs(scenario: Scenario): ToolSpec[] {
  // Take the gold specs from `candidate_pool` (where they're guaranteed to be
  // present per ingest contract). If a gold id is somehow missing from the
  // pool, synthesize a minimal spec so selection is still possible — the agent
  // can't be expected to pick a tool that was never registered.
  const byId = new Map(scenario.candidate_pool.map((t) => [t.id, t]));
  return scenario.gold_tools.map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: id,
        description: `gold tool ${id} (synthesized: not in candidate_pool)`,
        input_schema: {},
      },
  );
}

/**
 * Mix a string id into a 32-bit numeric seed using FNV-1a. Same conceptual
 * mixing as the Rust runner (id bytes folded into the seed) so seeds derived
 * from the same `(id, seed)` are stable; the actual PRNG implementations differ.
 */
function mixSeed(scenarioId: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < scenarioId.length; i++) {
    h = Math.imul(h ^ scenarioId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: 32-bit state, fast, good enough for shuffling. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], seed: number): void {
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
