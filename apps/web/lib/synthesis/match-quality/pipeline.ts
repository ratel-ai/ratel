import { getLogger, type LogError } from "@/lib/platform/logger";
import { identityFingerprint, type JudgeEngine } from "@/lib/readings/decisions/judge";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import {
  applyAnswerKey,
  byArm,
  EVIDENCE_TIERS,
  type EvaluableSelection,
  type EvidenceTier,
  followThrough,
  observeSelections,
  revealedArmBias,
  summarizeAnswers,
} from "@/lib/synthesis/quality/ground-truth";
import { explainQualityGap, scoreObservations } from "@/lib/synthesis/quality/metrics";
import type { QualitySelectionDiagnostics } from "@/lib/synthesis/quality/queries";
import type { AnalystDeps, ParsedAnalystResult } from "./analyst";
import { analyse } from "./analyst";
import type { AnalystContext, QualityReadLine, RetrievalObservation } from "./context";
import { pickCandidates } from "./deficits";
import { declineReason, freezeEvidence, recountTiers } from "./evidence";
import { type JudgeCensus, judgeTargets } from "./judge";
import {
  applyLabels,
  buildReplayCases,
  type GroundTruthLabel,
  harvestLabels,
  mergeLabel,
  queryKey,
} from "./labels";
import { createBm25Spotchecker } from "./preview";
import type { ProposalInsert } from "./queries";
import { type ReplayPatch, type ReplayResult, replay } from "./replay";
import type { Candidate, CorpusEntry, DiagnosisPoint, EvalItem, RunCensus } from "./types";

/**
 * One match-quality run, start to finish, with every collaborator injected.
 *
 * The injection is not ceremony: it is what lets the whole run be tested with no
 * database, no telemetry and no model, which is the only way the decision this
 * feature exists to make (rewrite this description, or do not) is reviewable at
 * all.
 *
 * Order matters in two places and both are load-bearing:
 *
 *  - The census is taken and CHECKED before the model call. A thin window is a
 *    successful run that proposes nothing, not a cheap model call that produces
 *    confident prose from four data points.
 *  - Proposals are persisted by replacing the previous run's pending ones, in one
 *    transaction. Anything else leaves last week's answer on the page looking like
 *    this week's.
 */

const logger = getLogger("match-quality/pipeline");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

export interface RunDeps {
  /** The calibration's shadow-tested searches, from `lib/quality/queries.ts`. */
  loadSelections: (
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ) => Promise<{ selections: EvaluableSelection[]; diagnostics: QualitySelectionDiagnostics }>;
  /** Invoked tool ids keyed by search id, from the runtime-facts lane. */
  loadInvokedBySearchId: (
    projectId: string,
    searchIds: string[],
    window: ExperimentWindow,
  ) => Promise<Map<string, string>>;
  /** What retrieval was observed doing in this window. */
  observeRetrieval: (projectId: string, window: ExperimentWindow) => Promise<RetrievalObservation>;
  /** The corpus as retrieval currently matches on it, plus its fingerprint. */
  loadCorpus: (
    projectId: string,
  ) => Promise<{ entries: CorpusEntry[]; fingerprint: string | null }>;
  /**
   * The analyst, resolved against this run's assembled context.
   *
   * A factory rather than a value because the local stand-in derives its output
   * from the candidates and their evidence, which do not exist until the window
   * has been read. Handing the pipeline a pre-built dep would mean building the
   * context twice, once to make the mock and once to prompt with.
   *
   * Omit it to run the whole pipeline with no model: the census, the candidates
   * and the preview are still computed and persisted, and the run reports that
   * nothing was drafted. Same degradation `lib/jobs/handlers.ts` already uses for
   * the skill generators.
   */
  analyst?: (context: AnalystContext) => AnalystDeps;
  /**
   * The judge engine (`judges/index.ts`), asked about every sampled search.
   *
   * Omit it and every target without an invocation stays on the reference tier,
   * which is exactly the phase-1 behaviour. Present, it runs AFTER the thin-window
   * refusal and BEFORE candidates are picked, because a corrected target changes
   * which entries get nominated, which is the whole reason to spend the call.
   */
  judge?: JudgeEngine;
  /**
   * The project's accumulated answer key, from `labels.ts`.
   *
   * Read BEFORE judging, because a request somebody already decided must not be
   * re-decided: that is the whole mechanism by which each run's fixed judging
   * budget buys new answers instead of the same ones again.
   *
   * Optional, and an empty key is the phase-1 behaviour exactly: every target
   * without an invocation stays on the reference tier and the judge samples from
   * all of them.
   */
  loadLabels?: (projectId: string) => Promise<Map<string, GroundTruthLabel>>;
  /**
   * Every search this project has ever frozen, newest first.
   *
   * The backtest's population, unioned with this run's own frozen items.
   * Separate from `loadSelections` because it reads `match_quality_eval_items`
   * across ALL runs rather than one window of telemetry, which is what lets a
   * replay reach past the thirty-day pruning wall.
   *
   * PRESENCE OF THIS DEP IS THE SWITCH. `backtestWith` refuses to run without
   * it, so a caller that does not want a replay simply does not wire it and no
   * backtest is computed or stored. Gating only the *reads* would leave runs
   * quietly accruing a headline for a surface not meant to show one.
   */
  loadHistory?: (projectId: string) => Promise<EvalItem[]>;
  persist: (input: PersistInput) => Promise<void>;
  logError?: LogError;
}

export interface PersistInput {
  census: RunCensus;
  items: EvalItem[];
  scores: Record<string, unknown>;
  followThrough: Record<string, unknown>;
  observedStages: Record<string, unknown>;
  corpusFingerprint: string | null;
  model: string | null;
  mocked: boolean;
  diagnosis: string | null;
  /** The run-level findings behind the headline; empty when none were returned. */
  diagnosisPoints: DiagnosisPoint[];
  declinedReason: string | null;
  scorer: string;
  /** The judging census, or `{}` when no judge ran. */
  judge: Record<string, unknown>;
  /** What this run learned, to be folded into the project's answer key. */
  labels: GroundTruthLabel[];
  /** The whole proposal set replayed together. Null when no replay ran. */
  backtest: ReplayResult | null;
  proposals: ProposalInsert[];
}

export interface RunOutcome {
  census: RunCensus;
  candidatesFound: number;
  proposalsCreated: number;
  /** Set when the run deliberately produced nothing. */
  declinedReason: string | null;
  usedModel: boolean;
  /** Entry ids the model returned that the corpus does not contain. */
  rejectedEntryIds: string[];
  /** What the judging pass found, or null when none ran. */
  judge: JudgeCensus | null;
  /** The portfolio replay, or null when there was no history to replay. */
  backtest: ReplayResult | null;
  /** Requests written into the project's answer key by this run. */
  labelsWritten: number;
  /** Drafts the replay measured costing quality, stored but not offered. */
  proposalsDiscarded: number;
}

export interface RunOptions {
  projectId: string;
  projectName: string;
  experimentName: string;
  window: ExperimentWindow;
  mocked?: boolean;
}

/** Score every arm under both tiers, for the prompt and for the stored record. */
export function summariseQuality(
  selections: readonly EvaluableSelection[],
  census: RunCensus,
): { lines: QualityReadLine[]; gapNote: string | null } {
  // No baseline (search telemetry): each tier is still scored for the one
  // engine there is; there is just no gap to name.
  const baselineArm = census.baselineArm ?? "";

  const lines: QualityReadLine[] = [];
  const byTier = new Map<EvidenceTier, Map<string, ReturnType<typeof scoreObservations>>>();

  for (const tier of EVIDENCE_TIERS) {
    const observations = observeSelections(selections, tier, baselineArm, census.attributionMode);
    const scored = new Map<string, ReturnType<typeof scoreObservations>>();
    for (const [arm, armObservations] of byArm(observations)) {
      const score = scoreObservations(armObservations);
      scored.set(arm, score);
      // Both are null exactly when nothing was evaluable, and an arm with no
      // evaluable searches is an absence rather than a zero, so it is left off
      // the read instead of being printed as 0%.
      if (score.containment === null || score.quality === null) continue;
      // An arm that served these searches is graded on its own pick under the
      // revealed tier (100% by construction). Kept for the gap arithmetic, never
      // printed as a quality read.
      if (tier === "revealed" && revealedArmBias(selections, arm) !== "independent") continue;
      lines.push({
        arm,
        tier,
        n: score.n,
        containment: score.containment,
        quality: score.quality,
        top1: (score.rankHistogram["1"] ?? 0) / score.n,
      });
    }
    byTier.set(tier, scored);
  }

  // The gap is only worth naming where both arms were scored over the same
  // population; `observeSelections` under `recorded-rank` does not do that, and a
  // driver attributed across two populations is a sentence that reads as insight
  // and means nothing.
  // The answer key scores both arms over one population, so it is always a
  // fair basis; the revealed tier only is under `tool-id` attribution.
  let gapNote: string | null = null;
  const judgedTier = byTier.get("judged");
  const basis =
    judgedTier?.get(census.tunedArm ?? "") && judgedTier.get(baselineArm)
      ? judgedTier
      : census.attributionMode === "tool-id"
        ? byTier.get("revealed")
        : undefined;
  if (basis && census.tunedArm) {
    const ours = basis.get(census.tunedArm);
    const theirs = basis.get(baselineArm);
    if (ours && theirs) {
      const gap = explainQualityGap(ours, theirs);
      if (gap && gap.driver !== "even") {
        gapNote =
          gap.driver === "containment"
            ? "The gap against the baseline is mostly COVERAGE: the right answer is missing from our list more often than it is merely ranked low."
            : "The gap against the baseline is mostly RANKING: we usually return the right answer, but not near the top.";
      }
    }
  }
  return { lines, gapNote };
}

/** Run one project's analysis. Never throws for an empty or thin window. */ export async function runMatchQuality(
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  const logError = deps.logError ?? defaultLogError;
  const { projectId, experimentName, window } = options;

  const [{ selections, diagnostics }, corpus, retrieval, history, known] = await Promise.all([
    deps.loadSelections(projectId, experimentName, window),
    deps.loadCorpus(projectId),
    deps.observeRetrieval(projectId, window),
    // The backtest's population and the answer key that scores it. Both are
    // whole-project reads rather than window reads, and both are loaded even for
    // a window that turns out to be too thin to propose anything: a run that can
    // say nothing about THIS week can still say where the catalog stands over
    // everything ever recorded, and that is the more useful of the two answers.
    deps.loadHistory ? deps.loadHistory(projectId) : Promise.resolve<EvalItem[]>([]),
    deps.loadLabels
      ? deps.loadLabels(projectId)
      : Promise.resolve(new Map<string, GroundTruthLabel>()),
  ]);

  const invokedBySearchId = await deps.loadInvokedBySearchId(
    projectId,
    selections.map((selection) => selection.selectionId),
    window,
  );

  const frozen = freezeEvidence(selections, diagnostics, invokedBySearchId);

  // The answer key, applied before anything reads the targets. A request some
  // earlier run already decided arrives here already decided, which is what keeps
  // the judge's fixed budget pointed at requests nobody has answered yet.
  const promoted = applyLabels(frozen.items, known);
  let items = promoted;
  let census = recountTiers(promoted, frozen.census);

  // Recomputed below once this run's verdicts are in the key, so the numbers a
  // run stores include the searches it just paid to answer.
  let { lines, gapNote } = summariseQuality(selections, census);
  let answers = summarizeAnswers(selections);
  const follow = followThrough(selections);

  const ourArm = census.tunedArm ?? "";
  const nameById = new Map(corpus.entries.map((entry) => [entry.entryId, entry.name]));

  const baseOf = (forCensus: RunCensus, forItems: readonly EvalItem[]) => ({
    census: forCensus,
    items: [...forItems],
    scores: { arms: lines, answers } as Record<string, unknown>,
    followThrough: follow as unknown as Record<string, unknown>,
    observedStages: retrieval as unknown as Record<string, unknown>,
    corpusFingerprint: corpus.fingerprint,
  });

  /**
   * Replay the accumulated history against a patch set.
   *
   * Pure and model-free, so it runs on every path including the ones that
   * propose nothing. With no patches it still reports where the catalog stands
   * today and how the incumbent scores over the same population, which is the
   * number the surface leads with whether or not this window had anything to say.
   */
  const backtestWith = (
    scoredItems: readonly EvalItem[],
    key: ReadonlyMap<string, GroundTruthLabel>,
    patches: readonly ReplayPatch[],
  ): ReplayResult | null => {
    // `loadHistory` IS the switch. Without it no replay runs at all, so a caller
    // that does not want one computes and stores nothing, rather than quietly
    // accruing a headline for a surface not meant to show it.
    if (!deps.loadHistory) return null;
    if (ourArm === "") return null;
    const cases = buildReplayCases(
      [...scoredItems, ...history],
      key,
      ourArm,
      census.baselineArm ?? "",
    );
    if (cases.length === 0) return null;
    try {
      return replay(corpus.entries, cases, patches);
    } catch (error) {
      // Same bargain the judge strikes: a replay that fails costs this run its
      // headline number, not its proposals. The evidence, the candidates and the
      // rewrites are all still good, and a page without the panel is a smaller
      // loss than a run marked failed over a scorer that choked on one row.
      logError("match quality backtest failed", error, { project_id: projectId });
      return null;
    }
  };

  // — judging: every search without a real answer is eligible —
  //
  // Taken BEFORE the thin-window refusal, unlike the analyst: the answer key is
  // what the admin quality page and every backtest score against, so a window
  // too quiet to propose anything is still worth reading. It is also cheap: a
  // quiet window has few requests, and ones judged before are not paid for again.
  let judgeCensus: JudgeCensus | null = null;
  let verdictLabels: GroundTruthLabel[] = [];
  if (deps.judge && ourArm !== "") {
    try {
      // A provisional candidate pass, on the UNJUDGED items, purely to learn
      // which searches are already on course to nominate an entry. Those jump
      // the judge's queue: a run that judges a random subset of the
      // disagreements and misses the ones driving proposals has spent the call
      // and kept the risk. Cheap, because `pickCandidates` is pure and runs
      // again on the judged set a few lines below.
      const provisional = pickCandidates(items, ourArm, census.baselineArm ?? "", { nameById });
      const priority = new Set(
        provisional.flatMap((candidate) =>
          candidate.failures
            .map((failure) => failure.selectionId)
            .filter((id): id is string => id !== undefined),
        ),
      );
      const judged = await judgeTargets(
        items,
        corpus.entries,
        ourArm,
        census.baselineArm ?? "",
        deps.judge,
        {
          mocked: options.mocked ?? false,
          priority,
          key: known,
          fingerprint: identityFingerprint(corpus.entries),
        },
      );
      if (judged) {
        items = judged.items;
        census = recountTiers(judged.items, census);
        judgeCensus = judged.census;
        verdictLabels = judged.labels;
      }
    } catch (error) {
      // A judge that fails costs this run its new answers, not its output. Every
      // search it would have answered stays unanswered and out of the numbers,
      // which is the behaviour of a deployment with no judge at all.
      logError("match quality judging failed", error, { project_id: projectId });
    }
  }

  // What the run learned: this pass's verdicts (abstentions included) and every
  // observed invocation. Folded into the key BEFORE the replay reads it, so a
  // verdict bought a moment ago already counts toward the number it prints.
  // Merged within the batch first: one request can carry both a verdict and an
  // observed invocation from another sighting, and one upsert statement cannot
  // touch the same row twice.
  const batch = new Map<string, GroundTruthLabel>();
  for (const label of [...verdictLabels, ...harvestLabels(items)]) {
    batch.set(label.queryKey, mergeLabel(batch.get(label.queryKey) ?? null, label));
  }
  const learned = [...batch.values()];
  const key = new Map(known);
  for (const label of learned)
    key.set(label.queryKey, mergeLabel(key.get(label.queryKey) ?? null, label));
  {
    const scored = applyAnswerKey(selections, key, queryKey);
    ({ lines, gapNote } = summariseQuality(scored, census));
    answers = summarizeAnswers(scored);
  }

  // — the refusal, taken before the analyst spends anything —
  const thin = declineReason(census);
  if (thin !== null) {
    await deps.persist({
      ...baseOf(census, items),
      model: null,
      mocked: options.mocked ?? false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: thin,
      scorer: "none",
      judge: {},
      labels: learned,
      backtest: backtestWith(items, known, []),
      proposals: [],
    });
    return {
      census,
      candidatesFound: 0,
      proposalsCreated: 0,
      proposalsDiscarded: 0,
      declinedReason: thin,
      usedModel: false,
      rejectedEntryIds: [],
      judge: null,
      backtest: null,
      labelsWritten: learned.length,
    };
  }

  // Only searches with a real answer can nominate a rewrite. A search nobody has
  // answered used to count as a miss against the incumbent's first result, which
  // is how a healthy tool got nominated for a rewrite it did not need.
  const answered = items.filter((item) => item.targetSource !== "reference");
  const candidates =
    ourArm === "" ? [] : pickCandidates(answered, ourArm, census.baselineArm ?? "", { nameById });

  const base = baseOf(census, items);
  const judgeBlob = (judgeCensus ?? {}) as unknown as Record<string, unknown>;

  if (candidates.length === 0) {
    const reason =
      "Every entry the agents searched for was already returned first, so there is nothing to tune in this window.";
    const standing = backtestWith(items, key, []);
    await deps.persist({
      ...base,
      model: null,
      mocked: options.mocked ?? false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: reason,
      scorer: "none",
      judge: judgeBlob,
      labels: learned,
      backtest: standing,
      proposals: [],
    });
    return {
      census,
      candidatesFound: 0,
      proposalsCreated: 0,
      proposalsDiscarded: 0,
      declinedReason: reason,
      usedModel: false,
      rejectedEntryIds: [],
      judge: judgeCensus,
      backtest: standing,
      labelsWritten: learned.length,
    };
  }

  const context: AnalystContext = {
    projectName: options.projectName,
    census,
    retrieval,
    quality: lines,
    gapNote,
    referenceAccuracy: judgeCensus?.referenceAccuracy ?? null,
    corpus: corpus.entries,
    candidates,
  };

  if (!deps.analyst) {
    const reason =
      "No analysis model is configured on this deployment, so the evidence below was " +
      "gathered but nothing was drafted from it.";
    logError("match quality analysis skipped", undefined, {
      candidates: candidates.length,
      project_id: projectId,
      reason: "model_not_configured",
    });
    const standing = backtestWith(items, key, []);
    await deps.persist({
      ...base,
      model: null,
      mocked: options.mocked ?? false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: reason,
      scorer: "none",
      judge: judgeBlob,
      labels: learned,
      backtest: standing,
      proposals: [],
    });
    return {
      census,
      candidatesFound: candidates.length,
      proposalsCreated: 0,
      proposalsDiscarded: 0,
      declinedReason: reason,
      usedModel: false,
      rejectedEntryIds: [],
      judge: judgeCensus,
      backtest: standing,
      labelsWritten: learned.length,
    };
  }

  const analyst = deps.analyst(context);
  const result: ParsedAnalystResult = await analyse(context, analyst);
  if (result.rejectedEntryIds.length > 0) {
    logError("match quality analyst returned unusable entries", undefined, {
      project_id: projectId,
      rejected: result.rejectedEntryIds.length,
    });
  }

  // Spot-checked over answered searches only, like the candidates: a search
  // nobody answered has no target to win.
  const scorer = createBm25Spotchecker(corpus.entries, answered, ourArm);
  const byEntry = new Map(corpus.entries.map((entry) => [entry.entryId, entry]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.entryId, candidate]));

  const drafted: ProposalInsert[] = [];
  for (const proposal of result.proposals) {
    const entry = byEntry.get(proposal.entryId);
    if (!entry) continue;
    const patch = {
      entryId: proposal.entryId,
      searchableDescription: proposal.searchableDescription,
    };
    drafted.push({
      proposal,
      entry,
      // The spot-check is kept alongside the replay rather than replaced by it.
      // They answer different questions: the spot-check asks whether a rewrite
      // does its own job on the searches it was drafted for, the replay asks what
      // it costs everywhere else. A reader deciding whether to apply one wants
      // both, and dropping the first would have made this a breaking change to a
      // surface that already ships.
      preview: scorer.previewFor(patch),
      backtest: backtestWith(items, key, [patch]),
      evidence: evidenceFor(
        candidateById.get(proposal.entryId),
        proposal.expectedEffect,
        proposal.details,
      ),
    });
  }

  // — the guard: a rewrite measured to cost quality is not offered —
  //
  // The burden of proof sits on the rewrite. A draft whose own replay comes back
  // negative has no case for being applied, and leaving it in the list spends a
  // reader's attention on a change that makes the catalog worse. Measured on
  // acme-mcp's thirteen live proposals: six were net-negative, and dropping
  // them was worth 1.17 points on top of applying everything.
  //
  // DELETED, not stored. An earlier version kept them as `dismissed` rows so a
  // curious reader could audit what was rejected, and that was the wrong trade:
  // it filled a Closed section with text nobody should apply, and a suggestion
  // the evidence has already refused is not a suggestion. Only the COUNT
  // survives, on the run's backtest, so the panel can say how many were thrown
  // away without offering them.
  //
  // The test is `delta < 0`, not "a significant loss". Requiring significance
  // would keep every rewrite the scorer could not resolve, which on a 45%-fidelity
  // replay is most of them, and the asymmetry is the point: a gain we cannot
  // confirm costs a reader nothing, while a loss we cannot confirm is a live
  // regression sitting behind an Apply button.
  //
  // The same burden applies to a rewrite that measured no gain at all. Offering
  // one put "No change" beside an Apply button, which asks a reader to spend a
  // decision on a change the evidence says does nothing.
  const proposals = drafted.filter((row) => earnsItsPlace(row));
  const discarded = drafted.filter((row) => !earnsItsPlace(row));
  if (discarded.length > 0) {
    logError("match quality discarded rewrites that measured no gain", undefined, {
      project_id: projectId,
      discarded: discarded.length,
      kept: proposals.length,
    });
  }

  // The portfolio: every proposal applied at once. NOT the sum of the per-entry
  // replays above, because the rewrites share one corpus and compete for the same
  // queries, so two that each look like a gain alone can cancel together. This is
  // the number the headline prints, because "apply all" is the action it labels.
  const portfolio = backtestWith(
    items,
    key,
    // Only what is actually being offered. Including the discarded ones would
    // make the headline describe a set nobody can apply.
    proposals.map((row) => ({
      entryId: row.proposal.entryId,
      searchableDescription: row.proposal.searchableDescription,
    })),
  );

  await deps.persist({
    ...base,
    model: analyst.model,
    mocked: options.mocked ?? false,
    diagnosis: result.diagnosis.headline || null,
    diagnosisPoints: result.diagnosis.points,
    declinedReason:
      proposals.length === 0
        ? discarded.length > 0
          ? `The model drafted ${discarded.length} rewrite${discarded.length === 1 ? "" : "s"}, and the replay measured none of them helping, so none are offered.`
          : "The model reviewed the evidence and proposed no changes."
        : null,
    // Still the SPOT-CHECK's id, not the replay's. This column has always named
    // what produced a proposal's `preview`, and the preview is still the
    // spot-check; the replay reports its own scorer inside `backtest`. Widening
    // this to mean "the strongest scorer that ran" would silently change what
    // every stored row and every dashboard reading it already means.
    scorer: scorer.id,
    judge: judgeBlob,
    labels: learned,
    // The count rides on the blob rather than in a column of its own: it is read
    // by exactly one line of one panel, and a jsonb field costs no migration.
    backtest: portfolio === null ? null : { ...portfolio, discarded: discarded.length },
    proposals,
  });

  return {
    census,
    candidatesFound: candidates.length,
    proposalsCreated: proposals.length,
    proposalsDiscarded: discarded.length,
    declinedReason: null,
    usedModel: true,
    rejectedEntryIds: result.rejectedEntryIds,
    judge: judgeCensus,
    backtest: portfolio,
    labelsWritten: learned.length,
  };
}

/**
 * Whether a drafted rewrite measured worse than leaving the entry alone.
 *
 * Containment decides, because containment is what the surface leads with: a
 * rewrite that pushes a tool out of the list an agent actually sees is the
 * failure worth refusing. Rank is the tie-breaker — a patch that keeps every
 * tool findable but buries them is still worse than leaving things alone, and
 * without the second test it would pass unchallenged.
 *
 * A draft with no replay behind it is never discarded: absence of measurement is
 * not evidence of harm, and on a deployment with no history every draft would
 * otherwise vanish.
 */
function costsQuality(row: ProposalInsert): boolean {
  const delta = row.backtest?.delta;
  if (!delta) return false;
  if (delta.containment < 0) return true;
  return delta.containment === 0 && delta.quality < 0;
}

/**
 * Whether a drafted rewrite has a measured gain worth an Apply button.
 *
 * Judged on the number the card prints: the tool's own searches, how many had
 * it in the list before and after. Where the replay has no per-tool counts, the
 * catalog-wide containment stands in, as it does on the card. Either way it
 * must also not cost the catalog quality.
 *
 * A draft with no replay behind it is kept, for the reason `costsQuality` gives.
 */
function earnsItsPlace(row: ProposalInsert): boolean {
  const result = row.backtest;
  if (!result?.delta) return true;
  if (costsQuality(row)) return false;
  const own = result.byEntry?.find((effect) => effect.entryId === row.proposal.entryId);
  if (
    own &&
    own.n > 0 &&
    typeof own.containedBefore === "number" &&
    typeof own.containedAfter === "number"
  ) {
    return own.containedAfter > own.containedBefore;
  }
  return result.delta.containment > 0;
}

/** The evidence stored beside a proposal, so the page never re-derives it. */
function evidenceFor(
  candidate: Candidate | undefined,
  expectedEffect: string,
  // Carried in the evidence blob rather than in a column of its own: it is read
  // only by the disclosure that prints it, and a jsonb field costs no migration.
  details: string,
): Record<string, unknown> {
  if (!candidate) return { expectedEffect, details };
  return {
    expectedEffect,
    details,
    targeted: candidate.targeted,
    misses: candidate.misses,
    buried: candidate.buried,
    distractions: candidate.distractions,
    loss: candidate.loss,
    failures: candidate.failures,
  };
}
