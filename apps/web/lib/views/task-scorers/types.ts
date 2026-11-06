export const SCORER_KINDS = [
  "ends_well",
  "max_self_corrections",
  "max_latency_ms",
  "max_cost_usd",
  "expected_tool",
  "max_tool_calls",
  "judge_criteria",
] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];
export type Outcome = "ok" | "error" | "unknown";

export type Scorer =
  | { kind: "ends_well" }
  | {
      kind: "max_self_corrections" | "max_latency_ms" | "max_cost_usd" | "max_tool_calls";
      max: number;
    }
  | { kind: "expected_tool"; tool: string }
  | { kind: "judge_criteria"; criteria: string };

/** A measured run. Null values mean that a measurement is unknown. */
export interface ScorerRun {
  criteriaPass?: boolean | null;
  firstList: readonly string[] | null;
  listKnown?: boolean;
  searches: number | null;
  calls: readonly string[] | null;
  outcomes?: readonly Outcome[] | null;
  failed: number | null;
  answered?: boolean | null;
  costUsd?: number | null;
  latencyMs?: number | null;
}

export interface ScorerResult {
  kind: ScorerKind;
  status: "pass" | "fail" | "skip";
  score: number;
  detail: string;
  /** The expected tool's rank, when its list is known. */
  rank?: number | null;
}

export interface OutcomeRun {
  steps: readonly ({ kind: "invoke"; targetId: string; outcome: Outcome } | { kind: "search" })[];
  costUsd?: number | null;
  durationMs?: number | null;
}

export interface OutcomeDefaults {
  endsWell: boolean;
  maxSelfCorrections: number | null;
  maxCostUsd: number | null;
  maxLatencyMs: number | null;
}
