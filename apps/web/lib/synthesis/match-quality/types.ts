/**
 * Shared, DB-free types for match quality: the run census, the frozen evaluation
 * set, the candidate shape the analyst reasons over, and the proposal lifecycle:
 * pure types the DB layer, the detectors, the generator and the HTTP routes all
 * agree on.
 */

import type { AttributionMode } from "@/lib/synthesis/quality/ground-truth";

export const RUN_TRIGGERS = ["scheduled", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["queued", "running", "analyzed", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "dismissed",
  "superseded",
  "reverted",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** How the right answer was named for one search. Never blended. */
export const TARGET_SOURCES = ["invoked", "reference", "judge"] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];

/** Which telemetry lane supplied invoked-tool identity for a whole run. */
export const REVEALED_SOURCES = ["experiment-invocation", "trace-events", "both", "none"] as const;
export type RevealedSource = (typeof REVEALED_SOURCES)[number];

/** One arm's recorded output for a frozen evaluation item. */
export interface EvalArm {
  arm: string;
  role: "serving" | "shadow" | null;
  resultIds: string[];
  resultScores: number[] | null;
}

/** One search, frozen: the query, the target, and what every arm returned. */
export interface EvalItem {
  selectionId: string;
  occurredAt: Date;
  query: string | null;
  targetEntryId: string;
  targetKind: string;
  targetSource: TargetSource;
  arms: EvalArm[];
}

/**
 * What a run could actually see.
 *
 * Stored beside the conclusion rather than recomputed for display, because a run
 * over thin telemetry and a run over rich telemetry produce the same shape of
 * output and only this tells them apart.
 */
export interface RunCensus {
  selectionsEvaluated: number;
  revealedN: number;
  referenceN: number;
  /** Reference items a judge resolved. Never overlaps `revealedN`. */
  judgedN: number;
  queriesCaptured: number;
  truncated: boolean;
  attributionMode: AttributionMode;
  invokedToolKey: string | null;
  revealedSource: RevealedSource;
  baselineArm: string | null;
  servingArm: string | null;
  /**
   * The arm whose lists the proposals are scored against: ours, defined as the
   * one the baseline picker did not choose. Distinct from `servingArm`, which
   * can be either side depending on how the experiment routes traffic.
   */
  tunedArm: string | null;
}

/**
 * Catalog text as a BM25 index can accept it: a trimmed string, never undefined.
 *
 * The types here say `searchable: string`, and at runtime it is not always one.
 * `runtime_catalog_entries.description` is nullable, so a tool synced without one
 * arrives as null or undefined however carefully the row is typed on the way in —
 * the demo catalog alone has two. The native registry rejects a missing
 * description by throwing (`Missing field 'description'`), which takes the whole
 * scorer, and with it the whole run, down with it.
 *
 * So this is the boundary check: whatever arrives, a string comes out. Callers
 * treat an empty result as "not indexable" and skip the entry, which costs
 * nothing real — BM25 cannot return a document with no terms, so such an entry is
 * unreachable in production too.
 */
export function indexableText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One catalog entry as the corpus sees it. */
export interface CorpusEntry {
  entryId: string;
  name: string;
  searchable: string;
  /**
   * What the agent is told the tool does, when it differs from `searchable`.
   * Optional because only the loader reads it from the catalog; fixtures and
   * rescoring build entries without it, and the judge falls back to `searchable`.
   */
  description?: string;
  /**
   * The searchable text the customer's SDK sent, BEFORE any Cloud override.
   * With `description` this is the tool's identity: what the judge reads, so a
   * rewrite Cloud applies can never make the judge agree with that rewrite.
   */
  runtimeSearchable?: string;
  /** "override" | "runtime" | "description", from lib/playground/descriptions.ts. */
  source: string;
  /** True when the searchable text is the agent description verbatim. */
  matchesAgentDescription: boolean;
  tags: string[];
}

/**
 * Who failed to surface the right tool for one search.
 *
 * The distinction matters because it calls for different surgery. A tool the
 * incumbent leads with and we do not return is OUR ranking problem. A tool
 * neither engine leads with is a gap in the catalog itself, and no amount of
 * re-ranking finds it.
 *
 * `nobody-found-it` is reachable only on judge-tier evidence: on the reference
 * tier the target IS the baseline's first result, so the baseline can never be
 * wrong by construction. That is the tier's blind spot, stated as a type.
 *
 * `we-buried-it` is no longer produced: a target anywhere in the list the agent
 * saw is a success (see `deficits.ts`). It stays in the union because proposals
 * stored before that change still carry in-list failures.
 */
export const COVERAGE_KINDS = ["nobody-found-it", "we-missed-it", "we-buried-it"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

/** One search this entry should have won, and where our arm actually put it. */
export interface CandidateFailure {
  /** The selection this came from, so the surface can link out to it. */
  selectionId?: string;
  query: string | null;
  /** Our rank for the target, 1-based, or null when we did not return it. */
  ourRank: number | null;
  /** What our arm put first instead. */
  ourTop: string | null;
  /** What the baseline put first. */
  baselineTop: string | null;
  targetSource: TargetSource;
}

/** Which of the three coverage cases one failure is. Pure, and shared by prompt and UI. */
export function coverageOf(failure: CandidateFailure, entryId: string): CoverageKind {
  if (failure.ourRank !== null) return "we-buried-it";
  return failure.baselineTop === entryId ? "we-missed-it" : "nobody-found-it";
}

/**
 * An entry worth asking the model about, with the evidence that nominated it.
 *
 * `loss` is one point per search whose target we did not return at all, the
 * same zero `lib/quality/metrics.ts:hitCredit` scores it. A target shown below
 * first place costs nothing here; it is counted in `buried` for context.
 */
export interface Candidate {
  entryId: string;
  name: string;
  /** Searches where this entry was the target and we did not return it. */
  misses: number;
  /** Searches where it was the target and we showed it below first. Not a failure. */
  buried: number;
  /** Searches where it was the target at all. */
  targeted: number;
  /** Searches where we returned it while something else was the target. */
  distractions: number;
  loss: number;
  failures: CandidateFailure[];
}

/**
 * What the analyst returns for one entry.
 *
 * `rationale` and `details` are split because one string could not serve both
 * readers. Production's rationales ran to 500-1100 characters of dense
 * analyst-to-analyst prose — evidence tiers, coverage cases, which inflections
 * were collapsed — printed directly under the proposed text, where nobody read
 * them. That content is genuinely useful (it is how a destructive shortening
 * gets caught) but it is an audit, not a caption.
 *
 * So the caption is `rationale`: one plain sentence saying what changed. The
 * audit is `details`, behind a disclosure, with the same rules it always had.
 */
export interface AnalystProposal {
  entryId: string;
  searchableDescription: string;
  /** One plain sentence, at most ~20 words: what changed. */
  rationale: string;
  /**
   * The full audit: which searches, which evidence, what was dropped.
   *
   * STORED, NOT SHOWN. The card prints only `rationale`. This is kept because
   * the prompt's shortening rule leans on it — a model made to state exactly
   * which phrasings it removed removes fewer of them — so it is an
   * accountability device first and a record second. It is on the proposal's
   * evidence blob for anyone who needs to audit a rewrite after the fact.
   */
  details: string;
  expectedEffect: string;
}

/** One finding in the run-level read. */
export interface DiagnosisPoint {
  title: string;
  detail: string;
}

/**
 * The run-level read, in two registers.
 *
 * A single paragraph was the wrong shape: the first production run returned a
 * genuinely good analysis as one 700-character block that nobody would read
 * standing up. A headline someone can take in at a glance, plus a few findings
 * they can skim, carries the same content and survives contact with a person.
 */
export interface AnalystDiagnosis {
  headline: string;
  points: DiagnosisPoint[];
}

/** The analyst's whole answer: a run-level read plus per-entry rewrites. */
export interface AnalystResult {
  diagnosis: AnalystDiagnosis;
  proposals: AnalystProposal[];
}

/** One query's rank for the target, before and after a patch. */
export interface SpotCheckHit {
  query: string;
  targetEntryId: string;
  before: number | null;
  after: number | null;
}

/**
 * A proposal's before/after preview, with the caveat attached to the number.
 *
 * `reproductionRate` is how often the UNPATCHED ranking reproduced the top result
 * the arm actually served. It is carried alongside every delta because a delta
 * smaller than the scorer's own error is not evidence of anything, and a preview
 * that hides its error bar reads as proof.
 */
export interface ProposalPreview {
  scorer: "bm25-spotcheck" | "hybrid-replay";
  hits: SpotCheckHit[];
  improved: number;
  worsened: number;
  unchanged: number;
  /** Null when no item in the run recorded a served list to check against. */
  reproductionRate: number | null;
  reproductionSample: number;
  /** True when the net movement is within the scorer's own error. */
  inconclusive: boolean;
}
