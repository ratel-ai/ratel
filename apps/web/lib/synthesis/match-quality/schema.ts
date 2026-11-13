import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * One match-quality run: a pass that reads a calibration window, scores it with
 * `lib/quality`, and asks a model which searchable descriptions to rewrite.
 *
 * The bulk of this row is a CENSUS, not a result. A run over thin telemetry and a
 * run over rich telemetry produce the same shape of output, and the only thing
 * that tells them apart is how much evidence there was, so the counts are stored
 * beside the conclusion rather than recomputed for display. `declined_reason` is
 * the case where the census was too thin to spend a model call at all, which is a
 * successful run with nothing to propose, not a failure.
 *
 * `scorer` and `refinement_rounds` are written and not yet read: they are where
 * the Phase 2 backtest reports which replay produced a proposal's preview.
 */
export const matchQualityRuns = pgTable(
  "match_quality_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The calibration read, i.e. `otel_logs.experiment_name`. */
    experimentName: text("experiment_name").notNull(),
    // "scheduled" | "manual".
    trigger: text("trigger").notNull(),
    // "queued" | "running" | "analyzed" | "failed".
    status: text("status").notNull().default("queued"),
    windowDays: integer("window_days").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    // — the census —
    selectionsEvaluated: integer("selections_evaluated").notNull().default(0),
    revealedN: integer("revealed_n").notNull().default(0),
    referenceN: integer("reference_n").notNull().default(0),
    /** Reference-tier searches a model judge resolved to a definite target. */
    judgedN: integer("judged_n").notNull().default(0),
    /** Evaluable searches whose query text survived content capture. */
    queriesCaptured: integer("queries_captured").notNull().default(0),
    /** True when the window held more selections than one run reads. */
    truncated: boolean("truncated").notNull().default(false),
    /** `tool-id` | `recorded-rank` | `none`, from lib/quality/ground-truth.ts. */
    attributionMode: text("attribution_mode").notNull().default("none"),
    /** Which candidate vocabulary key named the invoked tool, when one did. */
    invokedToolKey: text("invoked_tool_key"),
    // "experiment-invocation" | "trace-events" | "both" | "none".
    revealedSource: text("revealed_source").notNull().default("none"),
    baselineArm: text("baseline_arm"),
    servingArm: text("serving_arm"),
    /** The arm whose lists were tuned: ours, i.e. whichever is not the baseline. */
    tunedArm: text("tuned_arm"),
    followThrough: jsonb("follow_through").$type<Record<string, unknown>>().notNull().default({}),
    /** Retrieval stages telemetry actually reported; empty when none did. */
    observedStages: jsonb("observed_stages").$type<Record<string, unknown>>().notNull().default({}),
    /** Per arm, per tier, as scored at run time. */
    scores: jsonb("scores").$type<Record<string, unknown>>().notNull().default({}),
    /** The corpus this ran against; joins `catalog_fingerprints`. */
    corpusFingerprint: text("corpus_fingerprint"),
    // — the model —
    model: text("model"),
    /** True when a local stand-in produced the output instead of a model. */
    mocked: boolean("mocked").notNull().default(false),
    diagnosis: text("diagnosis"),
    /** The findings behind the headline: [{ title, detail }]. Empty when none. */
    diagnosisPoints: jsonb("diagnosis_points")
      .$type<Array<{ title: string; detail: string }>>()
      .notNull()
      .default([]),
    /** Set when the census was too thin to justify a model call. */
    declinedReason: text("declined_reason"),
    /**
     * What the judging pass could see and what it found, including the
     * stratified estimate of how often the baseline's top result was right.
     * Empty when no judge ran.
     */
    judge: jsonb("judge").$type<Record<string, unknown>>().notNull().default({}),
    // "none" | "bm25-spotcheck" | "bm25-replay" | "hybrid-replay".
    scorer: text("scorer").notNull().default("none"),
    /**
     * The portfolio backtest: this run's whole proposal set replayed together
     * against the project's accumulated answer key.
     *
     * Stored on the RUN rather than derived per proposal because applying twelve
     * rewrites is not the sum of applying each alone — they share a corpus and
     * compete for the same queries — and the question the headline answers is
     * what happens if you apply the set. Null when no replay ran.
     */
    backtest: jsonb("backtest").$type<Record<string, unknown>>(),
    refinementRounds: integer("refinement_rounds").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("match_quality_runs_project_created_idx").on(t.projectId, t.createdAt),
    // At most one live run per project, so the weekly sweep and a manual click
    // cannot race two model calls onto the same window.
    uniqueIndex("match_quality_runs_project_live_idx")
      .on(t.projectId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * The frozen evaluation set: one row per evaluable search a run scored.
 *
 * This exists because `otel_logs` is pruned at 30 days. Without it, "would this
 * edit have helped last month?" is unanswerable no matter how good the replay is,
 * because the queries it would replay are gone. Freezing the query, the target and
 * both arms' lists at run time is what makes a Phase 2 backtest possible, and it
 * also makes one reproducible: the same run re-scored later reads the same rows
 * rather than a window that has since moved.
 *
 * `target_source` records how the right answer was named. `invoked` is behaviour;
 * `reference` is the baseline's own first result, which is agreement rather than
 * accuracy; `judge` is reserved for the Phase 2 sampled model judge and is never
 * written today.
 */
export const matchQualityEvalItems = pgTable(
  "match_quality_eval_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => matchQualityRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    selectionId: text("selection_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Null when content capture was off for this search. */
    query: text("query"),
    targetEntryId: text("target_entry_id").notNull(),
    targetKind: text("target_kind").notNull().default("tool"),
    // "invoked" | "reference" | "judge".
    targetSource: text("target_source").notNull(),
    /** Every arm's ranked list for this search, as recorded. */
    arms: jsonb("arms").$type<MatchQualityEvalArm[]>().notNull().default([]),
  },
  (t) => [
    index("match_quality_eval_items_run_idx").on(t.runId),
    index("match_quality_eval_items_project_occurred_idx").on(t.projectId, t.occurredAt),
  ],
);

/** One arm's recorded output for a frozen evaluation item. */
export interface MatchQualityEvalArm {
  arm: string;
  role: "serving" | "shadow" | null;
  resultIds: string[];
  resultScores: number[] | null;
}

/**
 * The accumulating answer key: which tool each recorded request was asking for.
 *
 * Keyed on the normalized QUERY rather than on a selection, which is what makes
 * it compound. A judged verdict used to live only inside the run that paid for
 * it, so the next run over the same window saw an assumption again and either
 * re-bought the same forty answers or went back to trusting the incumbent. Keyed
 * on the request, a verdict is bought once and every later run inherits it, so
 * each run spends its judging budget on requests nobody has decided yet and the
 * labelled share of a project's history climbs at no extra cost.
 *
 * `source` is `invoked` (the agent ran it, which is behaviour) or `judge` (a
 * model read the request against the catalog and said so). A `reference` target
 * is NEVER written here: the incumbent's first result is an assumption the rest
 * of this surface is careful to label as one, and storing it in a table called
 * ground truth would launder it into a fact nothing would revisit.
 */
export const matchQualityLabels = pgTable(
  "match_quality_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Case-folded, whitespace-collapsed query text. The identity. */
    queryKey: text("query_key").notNull(),
    /** The verbatim wording of the most recent sighting, for display. */
    query: text("query").notNull(),
    /** Empty string when `source` is "unclear". */
    entryId: text("entry_id").notNull(),
    // "invoked" | "judge" | "unclear" (read by the judge and left undecided).
    source: text("source").notNull(),
    /** False when a judge answered but called it close. */
    confident: boolean("confident").notNull().default(true),
    /** The judge's own confidence in [0, 1], when it gave one. */
    confidence: doublePrecision("confidence"),
    /** The judge's second choice: the tool this request is confused with. */
    runnerUp: text("runner_up"),
    /**
     * Fingerprint of the tool identities (ids, names, agent descriptions, SDK
     * searchable text; never Cloud overrides) the verdict was made against. A
     * verdict whose fingerprint no longer matches the catalog is stale: still
     * used, and re-judged when budget allows.
     */
    catalogFingerprint: text("catalog_fingerprint"),
    /** The judging model, or null for an observed invocation. */
    model: text("model"),
    /** The most recent selection this was seen on, so it can be linked out to. */
    selectionId: text("selection_id"),
    /** How often this request has been seen. Accumulates across runs. */
    occurrences: integer("occurrences").notNull().default(1),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One answer per request per project. The upsert's conflict target, and what
    // makes a concurrent sweep and manual run converge instead of duplicating.
    uniqueIndex("match_quality_labels_project_query_idx").on(t.projectId, t.queryKey),
    index("match_quality_labels_project_entry_idx").on(t.projectId, t.entryId),
  ],
);

/**
 * One proposed searchable-description rewrite, awaiting a human.
 *
 * Only `tool` entries, and only `searchable_description_override`: that is the one
 * field the two-description contract makes Cloud-editable. Approval is always an
 * explicit action; there is no auto-apply path.
 *
 * `previous_override` is what makes Revert exact. Reverting by clearing the
 * override would silently discard an operator's earlier hand-written text, and an
 * apply-all across a whole catalog would then be unrecoverable, so the prior value
 * is captured before the write rather than reconstructed after it.
 *
 * `status` lifecycle: `pending` -> `applied` | `dismissed` | `superseded`, and
 * `applied` -> `reverted`. A later run supersedes whatever the previous run left
 * pending, so proposals never stack up across weeks.
 */
export const matchQualityProposals = pgTable(
  "match_quality_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => matchQualityRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    /** Denormalized so a proposal stays readable after a re-sync renames nothing. */
    entryName: text("entry_name").notNull(),
    // "pending" | "applied" | "dismissed" | "superseded" | "reverted".
    status: text("status").notNull().default("pending"),
    /** The resolved searchable text at draft time, and where it came from. */
    currentSearchable: text("current_searchable").notNull(),
    // "override" | "runtime" | "description".
    currentSource: text("current_source").notNull(),
    proposedSearchable: text("proposed_searchable").notNull(),
    rationale: text("rationale").notNull(),
    /** The queries and ranks this rewrite was drafted from. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** The labelled spot-check, with the reproduction rate it was measured at. */
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
    /** Phase 2's replay result. Null until a backtest scorer runs. */
    backtest: jsonb("backtest").$type<Record<string, unknown>>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** Clerk id of whoever applied it. */
    appliedBy: text("applied_by"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    /** `searchable_description_override` as it stood before apply; null = unset. */
    previousOverride: text("previous_override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("match_quality_proposals_run_idx").on(t.runId),
    index("match_quality_proposals_project_status_idx").on(t.projectId, t.status),
    // One pending proposal per entry, so re-running while a signal persists does
    // not stack duplicates.
    uniqueIndex("match_quality_proposals_pending_entry_idx")
      .on(t.projectId, t.entryId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type MatchQualityRunRow = typeof matchQualityRuns.$inferSelect;
export type NewMatchQualityRun = typeof matchQualityRuns.$inferInsert;
export type MatchQualityEvalItemRow = typeof matchQualityEvalItems.$inferSelect;
export type NewMatchQualityEvalItem = typeof matchQualityEvalItems.$inferInsert;
export type MatchQualityProposalRow = typeof matchQualityProposals.$inferSelect;
export type NewMatchQualityProposal = typeof matchQualityProposals.$inferInsert;
export type MatchQualityLabelRow = typeof matchQualityLabels.$inferSelect;
export type NewMatchQualityLabel = typeof matchQualityLabels.$inferInsert;
