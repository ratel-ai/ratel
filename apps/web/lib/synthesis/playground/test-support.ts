import type { BenchEntry } from "./bench-view";
import type { BenchSkill, BenchTool, RankedHit } from "./types";

/**
 * Baseline field sets for the Playground's shapes, spread into fixtures.
 *
 * These shapes carry two descriptions, a runtime key and usage estimates, and
 * most tests care about exactly one of them. Without a shared default, every
 * fixture in every suite has to restate the other six fields, which is both
 * noise and a trap: the day a field is added, the fix is eight identical edits
 * and the temptation is to reach for a cast instead.
 *
 * The defaults describe the SIMPLEST capability — no searchable description, no
 * runtime row, nothing observed — so a fixture that says nothing gets the
 * pre-runtime-catalog behavior, and a test that cares about the two texts
 * diverging has to say so out loud. That is the right way round: the
 * interesting case should never be the one you get by accident.
 */

/** A skill whose retrieval text is just its description. */
export const BENCH_SKILL_DEFAULTS = {
  searchableDescription: null,
} satisfies Partial<BenchSkill>;

/** A tool the runtime never ingested and telemetry never priced. */
export const BENCH_TOOL_DEFAULTS = {
  entryId: null,
  searchableDescription: null,
  searchableDescriptionOverride: null,
  tokens: 0,
  tokensProvenance: "absent",
  costUsd: 0,
  costProvenance: "absent",
} satisfies Partial<BenchTool>;

/** A bench row for a capability with one description and no usage. */
export const BENCH_ENTRY_DEFAULTS = {
  agentDescription: null,
  searchableDescriptionSource: "description",
  runtimeDefault: "",
  provenance: "observed",
  entryId: null,
  tokens: null,
  tokensProvenance: null,
  costUsd: null,
  costProvenance: null,
} satisfies Partial<BenchEntry>;

/** A hit whose matched text and returned text are the same string. */
export const RANKED_HIT_DEFAULTS = {
  searchableDescription: "",
  searchableDescriptionSource: "description",
} satisfies Partial<RankedHit>;
