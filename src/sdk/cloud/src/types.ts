/**
 * Wire types for the Ratel Cloud API. Shapes mirror the Cloud app's source of
 * truth (apps/cloud in the ratel-websites repo): `lib/skills-catalog/catalog.ts`
 * for the catalog, `lib/suggestions/http.ts` for suggestions.
 */

/**
 * A published skill as served by `GET /api/v1/catalog` — field-for-field the
 * SDK's own `Skill` shape, so it registers into a `SkillCatalog` unchanged.
 */
export interface CatalogSkillWire {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}

export interface CatalogResponse {
  /** Content hash of the published set — also served as the `ETag` header. */
  catalogVersion: string;
  skills: CatalogSkillWire[];
}

export type SuggestionType = "edit_skill" | "new_skill";

export type SuggestionSignalKind = "coverage_gap" | "surfaced_not_invoked" | "tool_error";

export type SuggestionStatus = "pending" | "approved" | "rejected" | "auto_applied" | "superseded";

export interface RetrievabilityRankEntry {
  query: string;
  /** 1-based rank, or null when not in the top-K. */
  rank: number | null;
  score: number | null;
}

export interface RetrievabilityPreview {
  queries: string[];
  before: RetrievabilityRankEntry[];
  after: RetrievabilityRankEntry[];
}

/** Mirrors Cloud's `SerializedSuggestion` (lib/suggestions/http.ts). */
export interface Suggestion {
  id: string;
  projectId: string;
  type: SuggestionType;
  signalKind: SuggestionSignalKind;
  status: SuggestionStatus;
  rationale: string;
  evidence: unknown;
  targetSkillId: string | null;
  targetSkillExpectedVersion: number | null;
  sourceQueryIntentId: string | null;
  /** Partial `{description?, tags?, body?}` for edit_skill; full skill fields for new_skill. */
  patch: unknown;
  retrievabilityPreview: RetrievabilityPreview | null;
  createdSkillId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

/** Per-run token/cost record for the coarse `POST /api/v1/events` stream. */
export interface RunMetrics {
  tokens_by_category: {
    skills: number;
    tools: number;
    history: number;
    memory: number;
    user_input: number;
  };
  saved_by_category?: Partial<RunMetrics["tokens_by_category"]>;
  saveable_by_category?: Partial<RunMetrics["tokens_by_category"]>;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  latency_ms?: number;
  cost_usd?: number;
  occurred_at?: string;
}
