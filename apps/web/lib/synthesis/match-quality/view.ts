import { APP_NAME } from "@/lib/platform/app-config";
import { MATCH_QUALITY_RUN_INTERVAL_MS } from "@/lib/readings/match-quality/sweep";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import { ATTRIBUTION_NOTES, type AttributionMode } from "@/lib/synthesis/quality/ground-truth";
// TYPE-ONLY, and it must stay that way. `replay.ts` imports the SDK's native
// registry, which reaches for `node:fs`; this module is pulled into the client
// bundle through Quality's run menu (`lib/quality/v2/run-menu.ts`), so a value
// import from here fails the build.
import type { EntryEffect, MovementKind, ReplayResult } from "./replay";
import type { CandidateFailure, ProposalPreview } from "./types";

/**
 * Turning stored rows into the sentences the page prints.
 *
 * Pure and separate from the components for the usual reason, plus one specific
 * to this surface: most of what it says is a caveat, and a caveat assembled in
 * JSX is a caveat nobody tests. The rules about when a preview may be read as
 * evidence, and when a census is too thin to trust, live here where they can be
 * asserted.
 */

export type RunPhase = "queued" | "running" | "analyzed" | "failed";

export interface RunStatusView {
  phase: RunPhase;
  label: string;
  /** True while the page should keep polling for a change. */
  live: boolean;
}

export function runStatus(run: Pick<MatchQualityRunRow, "status">): RunStatusView {
  switch (run.status) {
    case "queued":
      return { phase: "queued", label: "Queued", live: true };
    case "running":
      return { phase: "running", label: "Analysing", live: true };
    case "failed":
      return { phase: "failed", label: "Failed", live: false };
    default:
      return { phase: "analyzed", label: "Done", live: false };
  }
}

/** One line of the evidence census. */
export interface CensusFact {
  label: string;
  value: string;
  /** Present when the fact is a gap the reader should act on. */
  warning?: string;
}

/**
 * What the run could see, said plainly.
 *
 * Every gap is stated as a gap rather than omitted. A page that silently drops
 * "no invoked tool was recorded" reads as though the numbers above it were
 * measured against observed behaviour, when they were measured against the
 * baseline's opinion.
 */
export function censusFacts(run: MatchQualityRunRow): CensusFact[] {
  // A window with nothing in it has one fact, not six. Every row below is derived
  // from the searches that were scored, so with none of them the panel becomes
  // five zeroes and two red warnings about evidence that could not exist, which
  // reads as a broken feature rather than as an empty window.
  if (run.selectionsEvaluated === 0) {
    return [
      {
        label: "Searches scored",
        value: "0",
        warning:
          "No recorded search landed in this window, so there was nothing to measure. Check that searches are still being recorded, or widen the window.",
      },
    ];
  }

  const facts: CensusFact[] = [
    {
      label: "Searches scored",
      value: `${run.selectionsEvaluated}${run.truncated ? " (sampled across the window)" : ""}`,
    },
    {
      label: "Right answer from what the agent ran",
      value: String(run.revealedN),
      ...(run.revealedN === 0
        ? {
            warning:
              run.judgedN > 0
                ? "No search recorded which tool the agent invoked, so the right answers below were decided by a model reading each request against the catalog."
                : "No search recorded which tool the agent invoked and none has been decided yet, so there is nothing to score. The weekly pass decides them.",
          }
        : {}),
    },
    {
      label: "No answer yet (left out)",
      value: String(run.referenceN),
    },
    ...(run.judgedN > 0
      ? [
          {
            label: "Right answer decided by a model judge",
            value: String(run.judgedN),
          },
        ]
      : []),
    {
      label: "Searches with their query text stored",
      value: `${run.queriesCaptured} of ${run.selectionsEvaluated}`,
      ...(run.queriesCaptured < run.selectionsEvaluated
        ? {
            warning: "Content capture is off for the rest, so their wording could not be read.",
          }
        : {}),
    },
    {
      label: "Arms",
      value:
        run.tunedArm && run.baselineArm
          ? `tuning ${run.tunedArm} against ${run.baselineArm}${run.servingArm ? `; ${run.servingArm} served` : ""}`
          : run.tunedArm
            ? `tuning ${run.tunedArm} from its own recorded searches`
            : "not resolved",
    },
    {
      label: "Attribution",
      value: ATTRIBUTION_NOTES[run.attributionMode as AttributionMode] ?? run.attributionMode,
    },
  ];

  if (run.revealedSource === "trace-events") {
    facts.push({
      label: "Invoked tools read from",
      value: "runtime facts, joined on search id",
    });
  } else if (run.invokedToolKey) {
    facts.push({ label: "Invoked tools read from", value: run.invokedToolKey });
  }
  return facts;
}

/** How a preview should be read, given the scorer's own error rate. */
export interface PreviewView {
  /**
   * Three or four words, for the chip.
   *
   * The surface shows only this. The reasoning behind it is real and has to stay
   * available, but it is a paragraph, and a paragraph printed under every proposal
   * buried the proposal. It moves to {@link detail}, behind a hover.
   */
  chip: string;
  /**
   * What the chip's own words mean, in one sentence.
   *
   * Separate from {@link detail}, which explains the method. A reader seeing
   * "Inconclusive" first needs to know what was inconclusive and what would have
   * made it conclusive; how the check works is the next question, not the first.
   */
  meaning: string;
  /** The full explanation, for the tooltip: what moved, and what that is worth. */
  detail: string;
  tone: "improves" | "regresses" | "inconclusive";
  improved: number;
  worsened: number;
  unchanged: number;
  hits: ProposalPreview["hits"];
}

export function previewView(raw: unknown): PreviewView | null {
  const preview = raw as ProposalPreview | null;
  if (!preview || typeof preview !== "object" || !Array.isArray(preview.hits)) return null;

  const rate = preview.reproductionRate;
  const moved =
    preview.hits.length === 0
      ? "Nothing to check this against: none of the searches it lost stored their query text."
      : `Re-ranking its own failing searches moves it up on ${preview.improved} of ${preview.hits.length}${preview.worsened > 0 ? ` and down on ${preview.worsened}` : ""}.`;
  const accuracy =
    rate === null
      ? "This check has no measured accuracy on this window, so it cannot tell a real gain from its own error."
      : `The check itself reproduces the tool production actually served ${(rate * 100).toFixed(0)}% of the time here, across ${preview.reproductionSample} searches, so anything smaller than that is not evidence.`;
  const detail = `A keyword-only spot-check, not a backtest: it re-ranks with BM25 alone, while production also runs a semantic pass and then filters the list. ${moved} ${accuracy}`;

  const chip = preview.inconclusive
    ? preview.hits.length === 0
      ? "Not checkable"
      : "Inconclusive"
    : `${preview.improved} of ${preview.hits.length} better`;

  const meaning = preview.inconclusive
    ? preview.hits.length === 0
      ? "We could not try this rewrite out, because none of the searches it lost stored the words that were typed."
      : "We tried this rewrite on the searches it lost, and it did not move them enough to be sure the rewrite caused it rather than the rough check itself."
    : `We tried this rewrite on the ${preview.hits.length} search${preview.hits.length === 1 ? "" : "es"} it lost, and it pulled the tool higher on ${preview.improved} of them by more than this check's own error.`;

  return {
    chip,
    meaning,
    detail,
    tone: preview.inconclusive
      ? "inconclusive"
      : preview.improved > preview.worsened
        ? "improves"
        : "regresses",
    improved: preview.improved,
    worsened: preview.worsened,
    unchanged: preview.unchanged,
    hits: preview.hits,
  };
}

/**
 * The long audit stored beside a proposal, or null when there is none.
 *
 * Kept out of the card's own flow deliberately. Production's model wrote 500 to
 * 1100 characters here — evidence tiers, coverage cases, which inflections were
 * collapsed — and printed under the proposed text it buried the thing a reader
 * came to look at. It is real and worth keeping, so it moves behind a
 * disclosure rather than being thrown away or shortened into uselessness.
 */
export function proposalDetails(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).details;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The failing searches stored beside a proposal, ready to print.
 *
 * Only searches where we did not return the tool at all. A proposal stored
 * before in-list ranks stopped counting as failures can still carry rows like
 * "#2"; those were searches the agent was shown the tool on, which is a success,
 * so they are dropped here rather than printed as evidence against it.
 */
export function proposalFailures(raw: unknown): CandidateFailure[] {
  if (typeof raw !== "object" || raw === null) return [];
  const failures = (raw as Record<string, unknown>).failures;
  if (!Array.isArray(failures)) return [];
  return failures.filter(
    (failure): failure is CandidateFailure =>
      typeof failure === "object" &&
      failure !== null &&
      "ourRank" in failure &&
      failure.ourRank === null,
  );
}

/** Where a proposal's current text came from, in the catalog's own words. */
export function sourceLabel(source: string): string {
  if (source === "override") return `${APP_NAME} override`;
  if (source === "runtime") return "Runtime default";
  return "Same as the agent description";
}

export interface ProposalGroups {
  pending: MatchQualityProposalRow[];
  applied: MatchQualityProposalRow[];
  resolved: MatchQualityProposalRow[];
}

/**
 * Split proposals for display.
 *
 * `superseded` rows are kept out of `resolved` and off the page entirely: they
 * are the previous run's answer to a question this run has already re-answered,
 * and showing them invites somebody to apply stale text.
 */
export function groupProposals(rows: readonly MatchQualityProposalRow[]): ProposalGroups {
  return {
    pending: byImpact(rows.filter((row) => row.status === "pending")),
    applied: byImpact(rows.filter((row) => row.status === "applied")),
    resolved: rows.filter((row) => row.status === "dismissed" || row.status === "reverted"),
  };
}

/**
 * Worst first.
 *
 * This is what replaced the per-row meter. A reader scanning a list of twelve wants
 * to know which one matters most, and ordering answers that for free: the answer is
 * "the one at the top". A meter spent 24 pixels a row re-encoding a number the row
 * already printed in words, and on a page where every row has lost the same amount
 * it drew twelve identical full bars, which is noise wearing the costume of data.
 *
 * Name breaks the tie so the order is stable between renders rather than shifting
 * under a reader whenever two rows are level.
 */
function byImpact(rows: readonly MatchQualityProposalRow[]): MatchQualityProposalRow[] {
  return [...rows].sort((left, right) => {
    const delta = proposalImpact(right).lost - proposalImpact(left).lost;
    return delta !== 0 ? delta : left.entryName.localeCompare(right.entryName);
  });
}

/* — The headline ------------------------------------------------------------ */

/**
 * What the run header actually says.
 *
 * "Last run: Done" was a status where a sentence belonged: it named the machine's
 * state instead of the reader's answer, so the first line of the page said nothing
 * about the catalog. This says what was read and what came of it.
 */
export interface RunHeadline {
  /** One line, the reader's answer. */
  title: string;
  /** The provenance line under it: window, trigger, model. */
  detail: string;
  live: boolean;
  phase: RunPhase;
}

export function runHeadline(
  run: MatchQualityRunRow | null,
  proposalCount: number,
  now: Date = new Date(),
): RunHeadline {
  if (run === null) {
    return {
      title: "Not analysed yet",
      detail: "Runs automatically each week, or start one now.",
      live: false,
      phase: "analyzed",
    };
  }
  const status = runStatus(run);
  if (status.phase === "queued" || status.phase === "running") {
    return {
      title: status.phase === "queued" ? "Queued" : "Reading your searches",
      detail: `${run.windowDays} day window`,
      live: true,
      phase: status.phase,
    };
  }
  if (status.phase === "failed") {
    return {
      title: "That run did not finish",
      detail: run.error ?? "No reason was recorded.",
      live: false,
      phase: "failed",
    };
  }

  const scored = run.selectionsEvaluated;
  const title =
    scored === 0
      ? "Nothing to measure in that window"
      : proposalCount === 0
        ? `Read ${scored} search${scored === 1 ? "" : "es"}, nothing worth changing`
        : `${proposalCount} rewrite${proposalCount === 1 ? "" : "s"} from ${scored} search${scored === 1 ? "" : "es"}`;

  const parts = [
    `${run.windowDays} day window`,
    relativeTime(run.finishedAt ?? run.createdAt, now),
  ];
  // A mocked run names no model, because none ran. The chip in the header says why,
  // so the detail line does not repeat it.
  if (!run.mocked && run.model) parts.push(run.model);
  return { title, detail: parts.join(" · "), live: false, phase: "analyzed" };
}

/**
 * When the weekly sweep would next pick this project up.
 *
 * Shown because "runs weekly" without a date is the kind of promise a reader cannot
 * check, and the first question after reading a stale page is when it refreshes.
 * Null while a run is live, where the answer is "it is happening now".
 */
export function nextScheduledRun(
  run: MatchQualityRunRow | null,
  now: Date = new Date(),
): Date | null {
  if (run === null) return null;
  if (runStatus(run).live) return null;
  const due = new Date(run.createdAt.getTime() + MATCH_QUALITY_RUN_INTERVAL_MS);
  return due.getTime() <= now.getTime() ? null : due;
}

/** "3 days", "5 hours", "12 minutes" — the gap, not a timestamp. */
export function formatGap(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function relativeTime(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  return `${formatGap(at, now)} ago`;
}

/* — One proposal, as a collapsed row ---------------------------------------- */

/**
 * What a collapsed proposal row says about why it is here.
 *
 * A count of real events, not a score, so it needs no explanation and no legend.
 * There is deliberately no accompanying meter: the row already states the number in
 * words, and a second encoding of the same fact is decoration. Magnitude is carried
 * by ORDER instead (see {@link groupProposals}), which costs no pixels at all.
 */
export interface ProposalImpact {
  /**
   * Searches where this tool was the right answer and we did not return it.
   *
   * Showing it below first place is not counted: the agent saw it, so the search
   * worked. Older evidence blobs still carry a `buried` count; it is ignored.
   */
  lost: number;
  /** The same count, kept as its own field for existing callers. */
  missed: number;
  /** A phrase for the row, e.g. "missed on 3 searches". */
  label: string;
}

function evidenceNumber(evidence: unknown, key: string): number {
  if (typeof evidence !== "object" || evidence === null) return 0;
  const value = (evidence as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function proposalImpact(proposal: MatchQualityProposalRow): ProposalImpact {
  const missed = evidenceNumber(proposal.evidence, "misses");
  const lost = missed;
  const label =
    missed === 0 ? "no recorded miss" : `missed on ${missed} search${missed === 1 ? "" : "es"}`;
  return { lost, missed, label };
}

/** One engine's match quality against the answer key. */
export interface EngineQuality {
  arm: string;
  /** Share of answered searches where the right tool came FIRST. Null on runs stored before it. */
  top1: number | null;
  /** Share where the right tool was anywhere in the list. */
  containment: number;
  n: number;
}

/** How much of the window has a known answer. Every figure is over `answered`. */
export interface AnswerCoverageView {
  searches: number;
  answered: number;
  unclear: number;
  unread: number;
}

export interface QualityNumbersView {
  /** The engine being tuned (ours), measured on its own. */
  ours: EngineQuality | null;
  /** The incumbent, measured the same way on the same searches, as a number beside ours. */
  theirs: EngineQuality | null;
  coverage: AnswerCoverageView;
  /** Why both numbers read a little high, when some searches were left out as unclear. */
  caveat: string | null;
}

/**
 * The two numbers this surface leads with: each engine's match quality, measured
 * on its own against the answer key over the same searches.
 *
 * Nothing is assumed. A search counts only when its right tool is known (the
 * agent ran it, or the model decided it); the incumbent is scored exactly like
 * ours rather than defining what "right" means. Only the answer-key line is
 * used; runs stored before it existed show no numbers rather than a biased one.
 */
export function qualityNumbers(run: MatchQualityRunRow): QualityNumbersView | null {
  const scores = (run.scores ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(scores.arms) ? (scores.arms as Record<string, unknown>[]) : [];
  const tierLines = (tier: string) => lines.filter((line) => line.tier === tier);
  // Answer-key lines only. The revealed line grades the engine that SERVED each
  // search against the tool the agent picked from that engine's own list, which
  // is 100% by construction (Acme's ratel read "38 searches, 100%"). A run
  // with no answer-key line shows no numbers rather than that one.
  const chosen = tierLines("judged");
  const engine = (arm: string | null): EngineQuality | null => {
    if (!arm) return null;
    const line = chosen.find((row) => row.arm === arm);
    if (!line || typeof line.containment !== "number" || typeof line.n !== "number") return null;
    return {
      arm,
      top1: typeof line.top1 === "number" ? line.top1 : null,
      containment: line.containment,
      n: line.n,
    };
  };

  const stored = scores.answers as Partial<AnswerCoverageView> | undefined;
  const coverage: AnswerCoverageView =
    stored && typeof stored.searches === "number"
      ? {
          searches: stored.searches,
          answered: stored.answered ?? 0,
          unclear: stored.unclear ?? 0,
          unread: stored.unread ?? 0,
        }
      : {
          searches: run.selectionsEvaluated,
          answered: run.revealedN + run.judgedN,
          unclear: 0,
          unread: run.referenceN,
        };

  const ours = engine(run.tunedArm);
  const theirs = engine(run.baselineArm);
  if (!ours && !theirs && coverage.searches === 0) return null;
  return {
    ours,
    theirs,
    coverage,
    caveat: unclearCaveat(coverage.unclear, run.baselineArm !== null),
  };
}

/** Why neither engine has a number, when neither does. */
export type MissingEngineNumbers = "no-answers" | "no-judged" | "stored-before";

/**
 * Why the per-engine tiles are empty, or null when there is a number to show.
 *
 * Three different reasons, and only one of them is a stored run's age. Numbers
 * computed now, or a stored run that kept its answer census, already know how:
 * an empty tile there means no search had a JUDGED answer (a tool the agent ran
 * from the list it was shown cannot score that list), not an old run. Only a
 * stored run without the census predates per-engine numbers.
 */
export function missingEngineNumbers(
  numbers: Pick<QualityNumbersView, "ours" | "theirs" | "coverage">,
  source: "live" | "stored",
  run: Pick<MatchQualityRunRow, "scores">,
): MissingEngineNumbers | null {
  if (numbers.ours || numbers.theirs) return null;
  if (numbers.coverage.answered === 0) return "no-answers";
  if (source === "live") return "no-judged";
  const answers = ((run.scores ?? {}) as Record<string, unknown>).answers as
    | { searches?: unknown }
    | undefined;
  return answers && typeof answers.searches === "number" ? "no-judged" : "stored-before";
}

export const MISSING_ENGINE_NUMBERS_COPY: Record<MissingEngineNumbers, string> = {
  "no-answers": "No search in this window has a known answer yet. The weekly pass decides them.",
  "no-judged":
    "No search here has a judged answer yet. The tools your agent ran were picked from the list it was shown, so they cannot score that list. The weekly pass judges these searches.",
  "stored-before":
    "This run was stored before per-engine numbers existed. The next run shows them.",
};

/** Why the numbers read a little high when unclear searches were left out. */
export function unclearCaveat(unclear: number, comparing: boolean): string | null {
  if (unclear <= 0) return null;
  return comparing
    ? `${unclear} searches the model could not decide are left out for both engines, so both numbers are measured on the clearer requests and read a little high. The comparison between them stays fair.`
    : `${unclear} searches the model could not decide are left out, so this number is measured on the clearer requests and reads a little high.`;
}

/** "all with query text", or the shortfall stated as a fraction. */
export function captureNote(run: MatchQualityRunRow): string {
  if (run.selectionsEvaluated === 0) return "";
  return run.queriesCaptured === run.selectionsEvaluated
    ? "all with query text"
    : `${run.queriesCaptured} of ${run.selectionsEvaluated} with query text`;
}

/* — the backtest ------------------------------------------------------------- */

/** One movement bucket, ready to print. */
export interface MovementView {
  key: MovementKind;
  label: string;
  n: number;
  meaning: string;
}

/**
 * The headline a reader came for: what the catalog scores now, and what it would
 * score if these rewrites were applied.
 *
 * WHY THIS REPLACED A VERDICT CHIP. The surface used to answer this question with
 * "Inconclusive", which is a true statement about a spot-check and a useless one
 * to somebody deciding whether to click Apply. It is also, read plainly, a refusal
 * to answer. A paired replay over a labelled history CAN answer it, so this prints
 * the number and carries its uncertainty alongside instead of in place of it.
 *
 * TWO SCALES, NEVER CONFLATED. The absolute pair is on the replay's own scale: a
 * keyword-only reranking of a corpus that production also runs a dense pass over.
 * It is not the quality meter's figure and the copy never lets it be read as one.
 * The DELTA is the trustworthy half, because both sides carry the same scorer bias
 * and it subtracts out, which is exactly what a paired bootstrap estimates.
 */
export interface BacktestView {
  /**
   * "72%" — how often the right tool is in the list at all, as things stand.
   *
   * CONTAINMENT, not the rank-weighted score, and measured inside the window
   * each search actually had. This is the headline for the same reason the admin
   * meter prints Containment first: an agent reads every result it is given, so
   * being in the list is the outcome and being first is a refinement. It is also
   * the same question measured the same way, so the two surfaces agree.
   */
  before: string;
  /** The same figure with the rewrites applied. */
  after: string;
  /** The rank-weighted pair, reported beside the headline and never instead. */
  beforeQuality: string;
  afterQuality: string;
  /** "+9 points", or "no change". */
  delta: string;
  direction: "up" | "down" | "flat";
  /** "+4 to +13 points", the 95% paired interval. */
  range: string;
  /** True when that interval excludes zero. */
  significant: boolean;
  /** The one-line reading of the pair. */
  headline: string;
  /** What was replayed, and how much of it stands on a known answer. */
  population: string;
  movements: MovementView[];
  /**
   * The incumbent, or null when no search could measure it fairly.
   *
   * Deliberately NOT "over the same searches". It is scored only where the answer
   * was established independently of it, which on today's telemetry is a small
   * minority of the population — so it is labelled with its own `n` and never
   * presented as a like-for-like of the headline pair.
   */
  baseline: string | null;
  baselineN: number;
  baselineNote: string | null;
  /**
   * The honest head-to-head: what each engine really served, same searches,
   * same method, no replay. Null when nothing could be measured that way.
   */
  served: {
    n: number;
    /** "Showed the right tool first", which is what a reader means by accurate. */
    ourTop1: string;
    baselineTop1: string;
    /** "Had it anywhere in the list." */
    ourContainment: string;
    baselineContainment: string;
    ourListSize: string;
    baselineListSize: string;
    note: string;
    /**
     * Where the gap actually lives, in one sentence.
     *
     * The honest reframing, and the useful one: a single "ten points behind"
     * gives a reader nothing to act on, while the same evidence split by whether
     * the engines already agree says most traffic is untouched and names the
     * minority that is not. Null when one stratum was never measured.
     */
    split: string | null;
  } | null;
  /** The fidelity caveat, always present. */
  caveat: string;
  /** The same caveat in one sentence, for the chip's hover. */
  caveatShort: string;
  /** The headline restated in one short line, for under the pair. */
  summary: string;
  /** The population, in as few words as it can honestly be put. */
  footnote: string;
  /** Drafts the replay rejected. Counted only; they are not kept. */
  discarded: number;
  /** Entries the patch set cost ground, worst first. Often empty. */
  regressions: EntryEffect[];
  /** True when nothing was patched, so the pair is a standing reading. */
  standing: boolean;
}

/**
 * The order the buckets are read in: the two gains, then the two costs.
 *
 * Declared here rather than reused from `replay.ts` because this is a DISPLAY
 * order and that one is not. `unchanged` is deliberately absent: it is most of
 * every run and saying so tells a reader nothing.
 */
const REPORTED_MOVEMENTS = ["found", "promoted", "demoted", "lost"] as const;

const MOVEMENT_MEANING: Record<MovementKind, { label: string; meaning: string }> = {
  found: {
    label: "newly found",
    meaning:
      "Searches where the right tool was missing from our list entirely, and the rewrite puts it back in.",
  },
  promoted: {
    label: "ranked higher",
    meaning: "Searches where we already had the right tool and now put it nearer the top.",
  },
  demoted: {
    label: "ranked lower",
    meaning: "Searches where we still return the right tool but have pushed it further down.",
  },
  lost: {
    label: "dropped out",
    meaning:
      "Searches where we used to return the right tool and no longer do. The most expensive kind of regression.",
  },
  unchanged: { label: "unmoved", meaning: "Searches the rewrite did not affect either way." },
};

/** Percent with no decimal. The scale every rate on this surface uses. */
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** A change in a rate, stated in points so it cannot be read as a percent of a percent. */
function points(value: number): string {
  const rounded = Math.round(value * 100);
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} point${Math.abs(rounded) === 1 ? "" : "s"}`;
}

/** The same magnitude without a sign, for a sentence that supplies its own. */
function magnitude(value: number): string {
  const rounded = Math.abs(Math.round(value * 100));
  return `${rounded} point${rounded === 1 ? "" : "s"}`;
}

/**
 * Where the difference between the two engines actually sits.
 *
 * Reported as a share of TRAFFIC, not of the judged sample: the judge
 * deliberately over-samples disagreements, so a reader who reads the sample's
 * mix as the traffic's mix will think this happens far more often than it does.
 */
function splitNote(result: unknown): string | null {
  // Absent on every row written before the split shipped; the panel simply does
  // not draw the sentence rather than drawing it full of zeroes.
  if (num(result, "served", "strata", "agreed", "n") === 0) return null;
  if (num(result, "served", "strata", "disputed", "n") === 0) return null;
  const agreedShare = Math.round(num(result, "served", "strata", "agreed", "share") * 100);
  const disputedShare = Math.round(num(result, "served", "strata", "disputed", "share") * 100);
  return (
    `On ${agreedShare}% of searches both engines already lead with the same tool, and there the two are identical. ` +
    `The whole difference sits in the other ${disputedShare}%, where they disagree: there we have the right tool ` +
    `${percent(rate(result, "served", "strata", "disputed", "ourContainment"))} of the time against ` +
    `${percent(rate(result, "served", "strata", "disputed", "baselineContainment"))}. ` +
    "That minority is what every rewrite on this page is drafted against."
  );
}

/**
 * Every number this reads comes out of a jsonb column, so none of them can be
 * trusted to exist.
 *
 * `match_quality_runs.backtest` and `match_quality_proposals.backtest` are
 * written by whatever version of `replay.ts` was deployed at the time, and read
 * by whatever is deployed now. A field added today is simply ABSENT on every row
 * written before today, and the TypeScript type is a claim about new writes, not
 * a guarantee about old reads.
 *
 * This is not hypothetical: `averageWindow` was added in one commit and the page
 * crashed on the next render, because a row written an hour earlier had no such
 * key and `undefined.toFixed()` throws. The type said otherwise and the type was
 * describing the future.
 *
 * So the whole blob is parsed as unknown. A missing number reads as its neutral
 * value and the panel renders a slightly duller truth rather than an error page.
 */
function at(source: unknown, ...path: string[]): unknown {
  let cursor = source;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function num(source: unknown, ...path: string[]): number {
  const value = at(source, ...path);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A rate that may legitimately be absent, which is not the same as zero. */
function rate(source: unknown, ...path: string[]): number | null {
  const value = at(source, ...path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The one line under the pair.
 *
 * The old sentence carried the population, the window, the rank-weighted figure
 * and a clause about sampling error — accurate, and four facts where a reader
 * wanted one. This says what the number means and stops. Everything it dropped
 * is still on the panel, in the footnote or behind the chip.
 */
function summaryLine(
  result: unknown,
  direction: BacktestView["direction"],
  standing: boolean,
  deltaContainment: number,
  significant: boolean,
): string {
  if (standing) {
    return `The right tool shows up in ${percent(rate(result, "before", "containment"))} of searches as things stand.`;
  }
  if (direction === "flat")
    return "These rewrites do not measurably change how often the right tool shows up.";
  const verb = direction === "up" ? "more" : "fewer";
  const hedge = significant ? "" : " This is within the margin of error, so treat it as a hint.";
  return `About ${Math.abs(Math.round(deltaContainment * result_n(result)))} ${verb} searches out of ${result_n(result)} would surface the right tool.${hedge}`;
}

function result_n(result: unknown): number {
  return num(result, "n");
}

export function backtestView(raw: unknown): BacktestView | null {
  const result = raw as ReplayResult | null;
  if (!result || typeof result !== "object" || typeof result.n !== "number") return null;
  if (result.n === 0) return null;

  const deltaContainment = num(result, "delta", "containment");
  const deltaQuality = num(result, "delta", "quality");
  const moved =
    num(result, "movements", "found") +
    num(result, "movements", "lost") +
    num(result, "movements", "promoted") +
    num(result, "movements", "demoted");
  const standing = deltaContainment === 0 && deltaQuality === 0 && moved === 0;

  const direction =
    Math.round(deltaContainment * 100) === 0 ? "flat" : deltaContainment > 0 ? "up" : "down";

  const low = Math.round(num(result, "delta", "interval", "low") * 100);
  const high = Math.round(num(result, "delta", "interval", "high") * 100);
  const significant = at(result, "delta", "significant") === true;

  const labelled = num(result, "evidence", "invoked") + num(result, "evidence", "judged");
  const share = Math.round((labelled / result.n) * 100);

  // Absent on rows written before windowing shipped. Those were scored at a
  // fixed depth, so there is no per-search window to name and the sentence drops
  // the clause rather than inventing a number for it.
  const windowed = rate(result, "averageWindow");
  const window = windowed === null ? null : windowed.toFixed(1);
  const headline = standing
    ? `Over ${result.n} replayed search${result.n === 1 ? "" : "es"}, the right tool is somewhere in the list ${percent(rate(result, "before", "containment"))} of the time` +
      (window === null ? "" : `, judged inside the ${window} results the agent actually saw`) +
      `. Counting how near the top it lands, that is ${percent(rate(result, "before", "quality"))}.`
    : direction === "flat"
      ? "Applying these rewrites changes how often the right tool appears by less than a point either way."
      : direction === "up"
        ? `Applying these rewrites puts the right tool in the list ${magnitude(deltaContainment)} more often${significant ? "" : ", though the sample cannot rule out no change at all"}.`
        : `Applying these rewrites puts the right tool in the list ${magnitude(deltaContainment)} LESS often${significant ? ", which is a real regression on this evidence" : ", though the sample cannot rule out no change at all"}.`;

  const population =
    `${result.n} distinct search${result.n === 1 ? "" : "es"} replayed` +
    (window === null ? ", " : `, each judged inside the ${window} results it actually returned, `) +
    `${share}% of them against an answer we actually know` +
    (at(result, "truncated") === true ? ", sampled across the whole record" : "") +
    (num(result, "droppedUnknownTarget") > 0
      ? `. ${num(result, "droppedUnknownTarget")} more were skipped because the tool they wanted has left the catalog`
      : "");

  return {
    before: percent(rate(result, "before", "containment")),
    after: percent(rate(result, "after", "containment")),
    beforeQuality: percent(rate(result, "before", "quality")),
    afterQuality: percent(rate(result, "after", "quality")),
    delta: points(deltaContainment),
    direction,
    range: `${low >= 0 ? "+" : "−"}${Math.abs(low)} to ${high >= 0 ? "+" : "−"}${Math.abs(high)} points`,
    significant,
    headline,
    population,
    movements: REPORTED_MOVEMENTS.map((kind) => ({
      key: kind,
      label: MOVEMENT_MEANING[kind].label,
      n: num(result, "movements", kind),
      meaning: MOVEMENT_MEANING[kind].meaning,
    })).filter((row) => row.n > 0),
    baseline:
      at(result, "baseline") == null ? null : percent(rate(result, "baseline", "containment")),
    baselineN: num(result, "baselineN"),
    served:
      at(result, "served") == null
        ? null
        : {
            n: num(result, "served", "n"),
            ourTop1: percent(rate(result, "served", "ourTop1")),
            baselineTop1: percent(rate(result, "served", "baselineTop1")),
            ourContainment: percent(rate(result, "served", "ours", "containment")),
            baselineContainment: percent(rate(result, "served", "baseline", "containment")),
            ourListSize: num(result, "served", "ourAverageReturned").toFixed(1),
            baselineListSize: num(result, "served", "baselineAverageReturned").toFixed(1),
            note:
              `What each engine actually returned, over the ${num(result, "served", "n")} search${num(result, "served", "n") === 1 ? "" : "es"} ` +
              "whose right answer was decided independently of both of them. No replay is involved, so neither " +
              "number carries any scorer error, and both are measured over the same searches — which is what makes " +
              "them comparable to each other, and what the two percentages above are NOT. " +
              `Note the list sizes: we return ${num(result, "served", "ourAverageReturned").toFixed(1)} results on average against ` +
              `${num(result, "served", "baselineAverageReturned").toFixed(1)}, and a longer list makes "had it anywhere" easier to earn.`,
            split: splitNote(result),
          },
    baselineNote:
      result.baseline === null
        ? null
        : `The old engine, from the lists it actually returned — no replay, so no scorer error. Scored over ${result.baselineN} of the ${result.n} searches: the ones whose right answer was established independently of it, by an invocation or a judge. The rest are excluded because there the answer IS its own top result, so scoring it would only ask whether it agrees with itself.`,
    caveatShort:
      "A keyword-only replay of your past searches. Production also runs a semantic pass, so read the CHANGE rather than the two percentages.",
    summary: summaryLine(result, direction, standing, deltaContainment, significant),
    footnote:
      `${result.n} past search${result.n === 1 ? "" : "es"} replayed` +
      (window === null ? "" : `, judged inside the ${window} results each one returned`),
    discarded: num(result, "discarded"),
    caveat:
      "How often the right tool appears in the list at all — the same question the admin quality meter leads with, measured the same way, inside the results each search actually returned. " +
      "It is a keyword-only replay though: production also runs a semantic pass and then filters, so the two percentages sit on this check's own scale. " +
      (result.reproductionRate === null
        ? "Its accuracy could not be measured on this population."
        : `It picks the same winner production actually served ${percent(result.reproductionRate)} of the time here. `) +
      "The CHANGE between them is the reliable part: both sides carry the same bias, so it cancels.",
    regressions: (Array.isArray(result.byEntry) ? result.byEntry : [])
      .filter((effect) => typeof effect?.delta === "number" && effect.delta < 0)
      .slice(0, 5),
    standing,
  };
}
