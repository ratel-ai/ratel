/**
 * The JSON shapes the Explore surface renders (and a future agent surface would
 * return). Kept dependency-free (types only) so the generative-UI components can
 * import them without pulling in any server code — the serializers in
 * `lib/agent-tools/serialize.ts` produce exactly these, and the cards render
 * them.
 */

/** Per-source token sums (skills/tools/history/memory/user_input). */
export type SourceSums = Record<string, number>;

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  searchableDescription: string | null;
  tags: string[];
  /** The SDK's `tools` (the `skills.tools` column). */
  tools: string[];
  status: string;
  version: number;
  /** Scope: null = global (project-wide); set = tailored to one opaque end-user.
   * User-scoped skills are not served by the SDK catalog sync yet. */
  endUserId: string | null;
  model: string | null;
  updatedAt: string;
  publishedAt: string | null;
}

export interface SkillFull extends SkillSummary {
  metadata: Record<string, string[]>;
  body: string;
  createdAt: string;
}

export interface UsageDay {
  day: string;
  costUsd: number;
  outputTokens: number;
  latencyMs: number;
  runs: number;
}

export interface UsageTotals {
  costUsd: number;
  outputTokens: number;
  latencyMs: number;
  runs: number;
  spend: SourceSums;
  saved: SourceSums;
  saveable: SourceSums;
}

export interface UsageSummaryOutput {
  rangeDays: number;
  totals: UsageTotals;
  days: UsageDay[];
}

export interface UsageSignalsOutput {
  searchedNotInvoked: Array<{ skillId: string; searchAppearances: number }>;
  topErroringTools: Array<{ toolId: string; errors: number }>;
  topSearchQueries: Array<{ query: string; searches: number }>;
}

export interface ListSkillsOutput {
  count: number;
  skills: SkillSummary[];
}

export interface GetSkillOutput {
  found: boolean;
  skill?: SkillFull;
}
