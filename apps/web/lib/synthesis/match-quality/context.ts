import { CATALOG_DESCRIPTIONS } from "@/lib/ingest/catalogs/vocabulary";
import { APP_NAME } from "@/lib/platform/app-config";
import { ATTRIBUTION_NOTES } from "@/lib/synthesis/quality/ground-truth";
import { type Candidate, type CorpusEntry, coverageOf, type RunCensus } from "./types";

/**
 * The evidence bundle handed to the analyst, assembled once and pure.
 *
 * Pure so the prompt is snapshot-testable without a database or a model. It is
 * also the reason the prompt can be reviewed as a product decision rather than
 * discovered in a log.
 *
 * Four things go in that a person doing this by hand would have had to remember,
 * and forgetting any one of them is how the manual loop produced bad rewrites:
 *
 *  - WHICH TEXT IS MATCHED ON. Rewriting the agent description does nothing to
 *    retrieval, and the two are identical in most projects, so a model shown only
 *    "the description" will confidently tune the wrong string.
 *  - HOW IT IS MATCHED. BM25 saturates on repetition, so the intuitive fix of
 *    stuffing the same keyword in five times is worth almost nothing, while three
 *    distinct phrasings are worth a lot.
 *  - WHAT THE EVIDENCE IS WORTH. A target named by the agent actually invoking it
 *    is behaviour; a target taken from the baseline's first result is agreement
 *    with the baseline, and optimizing for it converges on the baseline and stops.
 *    The model is told which it is looking at, per search.
 *  - WHAT WE DO NOT KNOW. Cloud stores no per-project retrieval configuration, so
 *    the observed stages are reported as observation, and their absence is
 *    reported as absence rather than guessed at.
 */

export interface RetrievalObservation {
  /** Stage names telemetry reported, e.g. ["bm25", "dense", "rrf"]. */
  stages: string[];
  /** The top_k the runtime asked for, when recorded. */
  topK: number | null;
  /** Searches the observation was drawn from. */
  samples: number;
}

export interface QualityReadLine {
  arm: string;
  tier: string;
  n: number;
  containment: number;
  quality: number;
  /** Share of searches where the right tool came FIRST. Absent on runs stored before it. */
  top1?: number;
}

export interface AnalystContext {
  projectName: string;
  census: RunCensus;
  retrieval: RetrievalObservation;
  quality: QualityReadLine[];
  /** One sentence naming what the quality gap is mostly made of. */
  gapNote: string | null;
  /**
   * Kept for callers that still pass it; no longer rendered. The analyst sees no
   * reference-tier evidence any more, and both engines' accuracy against the
   * answer key already travels in `quality`.
   */
  referenceAccuracy?: number | null;
  corpus: readonly CorpusEntry[];
  candidates: readonly Candidate[];
}

/** Characters of corpus text one prompt carries. Candidates are listed first. */
export const MAX_CORPUS_CHARS = 60_000;

export const SYSTEM_PROMPT = [
  "# Who you are working for",
  "",
  "Ratel sells tool retrieval for AI agents. When an agent needs a tool it sends a",
  "natural-language request to us, and we return a ranked shortlist of tools from",
  "that customer's catalog. If the tool the agent wanted is missing from the list,",
  "the agent does the wrong thing or nothing. Anywhere in the list is a success:",
  "the agent reads every result it is shown. First place is better, but a tool",
  "shown lower down is not a problem to fix.",
  "",
  "This customer is running us as a SHADOW EXPERIMENT. Two engines answer every",
  "search: ours, and the incumbent they used before us. Only one of them is",
  "actually serving; the other runs alongside for comparison. You are tuning OUR",
  "engine, and the incumbent is the bar we have to clear.",
  "",
  "That framing matters more than it looks. Where the evidence below is only the",
  "incumbent's opinion, matching it exactly means you have reached parity and",
  "stopped. Where a model or a real invocation named the answer, you can beat the",
  "incumbent. Spend your effort on the second kind.",
  "",
  "# The one thing you can change",
  "",
  "Every catalog entry carries two different strings:",
  `  - ${CATALOG_DESCRIPTIONS.searchable.label}: ${CATALOG_DESCRIPTIONS.searchable.hint}`,
  `  - ${CATALOG_DESCRIPTIONS.agent.label}: ${CATALOG_DESCRIPTIONS.agent.hint}`,
  "You are editing the FIRST one and nothing else. The second is not yours to",
  "touch, and the agent never sees the first. In most projects the two are",
  "identical, which is exactly why this is easy to lose: the text you are given",
  "reads like a normal description, but its only job is to be found.",
  "",
  "# How matching actually works, including the part people get wrong",
  "",
  "An entry is indexed as its name, then its searchable description, then its tags.",
  "Ranking is BM25 fused with a dense semantic pass, after which the client may",
  "filter by its own scope rules and truncate the list.",
  "",
  "Three consequences, and the third is the one that gets mishandled:",
  "",
  "  1. THE NAME IS ALREADY INDEXED. Restating the entry's own name in its",
  "     description buys nothing. Spend the words on what a user would say instead.",
  "",
  "  2. REPEATING ONE TERM SATURATES. BM25 gives sharply diminishing credit to the",
  "     same term occurring again. Nine inflections of 'delete' score barely more",
  "     than one. Collapsing that kind of repetition is a real improvement.",
  "",
  "  3. DISTINCT VOCABULARY IS NOT REPETITION, AND LENGTH IS THE REAL COST. Adding",
  "     a phrase a user might actually type adds a term that can match. What it",
  "     also does is lengthen the document, and BM25 normalizes by length, so every",
  "     other term in that entry loses a little weight. So a tail of distinct",
  "     phrasings is a TRADE, not waste: each one buys recall for its own wording",
  "     and costs a little sharpness everywhere else. Judge it per phrase, never as",
  "     'this tail is too long'.",
  "",
  "# Deleting words is the most dangerous thing you can do here",
  "",
  "You can see the searches this entry LOST. You cannot see the searches it is",
  "currently WINNING, and a phrase that looks like padding to you may be the only",
  "reason some other request lands here at all. Removing it is an untestable bet",
  "against evidence you were never shown.",
  "",
  "So:",
  "  - You MAY collapse repeated inflections of the same term (rule 2 above).",
  "  - You MAY remove a phrase when a failure below shows it pulling the WRONG",
  "    search to this entry.",
  "  - Otherwise, KEEP EVERY EXISTING PHRASE. Prefer adding a sentence that names",
  "    the distinction over deleting phrases that blur it.",
  "  - If you do shorten, your `details` must say exactly which phrasings you",
  "    dropped and why. A `details` that says 'removed some duplicates' while the",
  "    diff removes thirty distinct terms is a failed proposal, not a short one.",
  "",
  "# What good looks like",
  "",
  "  - One sentence of what it does, plus one clause of when to use it:",
  '    "<what it does>. Use when <when to call it>."',
  "  - Then a short clause of what it is NOT, when a sibling is close enough to be",
  "    confused with it. This is usually the highest-value sentence you can write.",
  "  - Then the existing tail of real phrasings, kept, plus the ones the failures",
  "    below show it losing on.",
  "  - Anemic (too short, or just restates the name) needs the full template.",
  "  - NEAR-SYNONYM COLLISIONS are the most common failure in this data: two",
  "    entries whose searchable text never says what makes them DIFFERENT. Fixing",
  "    one of a colliding pair usually means naming the distinction in BOTH, so",
  "    prefer that over piling more keywords onto the loser.",
  "",
  "# How much each piece of evidence is worth",
  "",
  "Each failing search says how its correct answer was established:",
  '  - "invoked": the agent actually ran that entry afterwards. This is behaviour,',
  "    and it is the strongest thing here. Trust it.",
  '  - "judge": a model read the request against the whole catalog and named this',
  "    entry. Stronger than the incumbent's opinion, because it can name an entry",
  "    NEITHER engine returned. Trust it, and say in your rationale that it is a",
  "    judged case.",
  "Searches nobody has an answer for are never shown to you: they are left out",
  "rather than scored against the incumbent's guess.",
  "",
  "# Who failed to find it, and why that changes the fix",
  "",
  "Every failure is a search where we did not return the right tool at all.",
  "Each is labelled with one of two cases:",
  "",
  '  - "nobody-found-it": neither engine led with this entry. This is a genuine gap',
  "    in how the entry describes itself, and it is the most valuable thing in the",
  "    run. Fix it by naming the missing capability in plain words, not by keyword",
  "    matching the one query.",
  '  - "we-missed-it": the incumbent led with it and we did not return it at all.',
  "    Our wording is missing vocabulary theirs has. Add the user's actual phrasing.",
  "",
  "# Rules",
  "",
  "NO INVENTED PROBLEMS. If an entry's searchable text is already tight and",
  "well-suited to the queries it is losing, propose nothing for it and leave it",
  "out. A run that proposes three well-evidenced changes is more useful than one",
  "that rewrites everything. An empty proposal list is a valid answer.",
  "",
  "You may only propose text for entry ids listed in the catalog below. Never",
  "invent an entry id. Never propose renaming anything. Never write anything about",
  "a customer's data that the evidence does not show.",
].join("\n");

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function corpusSection(corpus: readonly CorpusEntry[], candidates: readonly Candidate[]): string {
  const candidateIds = new Set(candidates.map((candidate) => candidate.entryId));
  // Candidates first, so a corpus that overruns the budget loses the entries the
  // model was never going to be asked about rather than the ones it was.
  const ordered = [
    ...corpus.filter((entry) => candidateIds.has(entry.entryId)),
    ...corpus.filter((entry) => !candidateIds.has(entry.entryId)),
  ];

  const lines: string[] = [];
  let budget = MAX_CORPUS_CHARS;
  let dropped = 0;
  for (const entry of ordered) {
    const tags = entry.tags.length > 0 ? `\n  tags: ${entry.tags.join(", ")}` : "";
    const note = entry.source === "override" ? ` (already overridden in ${APP_NAME})` : "";
    const line = `- ${entry.entryId}${note}\n  name: ${entry.name}\n  searchable: ${entry.searchable}${tags}`;
    if (line.length > budget) {
      dropped += 1;
      continue;
    }
    budget -= line.length;
    lines.push(line);
  }
  if (dropped > 0) {
    lines.push(`- ...and ${dropped} further entries omitted for length.`);
  }
  return lines.join("\n");
}

function candidateSection(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate) => {
      const header =
        `### ${candidate.entryId} (${candidate.name})\n` +
        `Was the right answer for ${candidate.targeted} search(es). ` +
        `We returned it nowhere in ${candidate.misses}. ` +
        `We showed it below first place in ${candidate.buried}, which counts as a success. ` +
        `It also appeared in our list on ${candidate.distractions} search(es) where something else was right.`;
      const failures = candidate.failures.map((failure) => {
        const where =
          failure.ourRank === null ? "we did not return it" : `we ranked it #${failure.ourRank}`;
        const query = failure.query === null ? "(query text not captured)" : `"${failure.query}"`;
        return (
          `  - ${query} [${failure.targetSource} | ${coverageOf(failure, candidate.entryId)}] -> ${where}; ` +
          `we put "${failure.ourTop ?? "nothing"}" first, the incumbent put "${failure.baselineTop ?? "nothing"}" first.`
        );
      });
      return [header, ...failures].join("\n");
    })
    .join("\n\n");
}

function retrievalSection(retrieval: RetrievalObservation): string {
  if (retrieval.samples === 0 || retrieval.stages.length === 0) {
    // Said explicitly rather than omitted. A model given no configuration section
    // assumes a default; a model told we did not observe one will say so.
    return (
      `Not observed in this window. ${APP_NAME} does not store a per-project retrieval ` +
      "configuration, and no search in this window reported its stages, so assume nothing " +
      "about whether a dense pass ran."
    );
  }
  const topK = retrieval.topK === null ? "not recorded" : String(retrieval.topK);
  return (
    `Observed on ${retrieval.samples} search(es): stages ${retrieval.stages.join(" -> ")}; ` +
    `requested top_k ${topK}.`
  );
}

function censusSection(census: RunCensus): string {
  const lines = [
    `Searches scored: ${census.selectionsEvaluated}${census.truncated ? " (sampled evenly across the window; it held more)" : ""}`,
    `Correct answer known from the agent's own behaviour: ${census.revealedN}`,
    `Searches with no answer yet (left out of everything): ${census.referenceN}`,
    `Searches whose query text was captured: ${census.queriesCaptured}`,
    `Baseline arm: ${census.baselineArm ?? "unknown"}; serving arm: ${census.servingArm ?? "unknown"}`,
    `Attribution: ${ATTRIBUTION_NOTES[census.attributionMode]}`,
  ];
  if (census.judgedN > 0) {
    lines.push(
      `Correct answer decided by a model judge: ${census.judgedN} (only where nothing observed it)`,
    );
  }
  if (census.revealedN === 0) {
    lines.push(
      "NOTE: no search in this window recorded which entry the agent actually ran, so every " +
        "correct answer below was decided by a model reading the request against the catalog.",
    );
  }
  if (census.queriesCaptured < census.selectionsEvaluated) {
    lines.push(
      `NOTE: ${census.selectionsEvaluated - census.queriesCaptured} search(es) have no query text ` +
        "(content capture is off for them), so they count toward the ranking evidence but you " +
        "cannot read what was asked.",
    );
  }
  return lines.join("\n");
}

/** Build the user message for one run. Pure and deterministic. */
export function buildAnalystPrompt(context: AnalystContext): {
  system: string;
  user: string;
} {
  const quality = context.quality
    .map(
      (line) =>
        `- ${line.arm} [${line.tier} tier, n=${line.n}]: ` +
        (line.top1 === undefined ? "" : `right answer first ${formatRate(line.top1)}, `) +
        `right answer returned at all ${formatRate(line.containment)}, ` +
        `rank-weighted quality ${formatRate(line.quality)}`,
    )
    .join("\n");

  const sections = [
    `# Project\n${context.projectName}`,
    `# What this run could see\n${censusSection(context.census)}`,
    `# Observed retrieval configuration\n${retrievalSection(context.retrieval)}`,
    `# Measured quality\n${quality || "No arm had enough evidence to score."}` +
      (context.gapNote ? `\n${context.gapNote}` : ""),
    `# The catalog, as retrieval currently matches on it\n${corpusSection(context.corpus, context.candidates)}`,
    `# The entries losing the most retrieval credit, worst first\n${candidateSection(context.candidates)}`,
    [
      "# Your task",
      "",
      "1. For each entry above that genuinely needs it, propose a full replacement",
      "   searchable description. Leave out entries that do not need one.",
      "",
      "   Then say why, in TWO separate registers, and do not blur them:",
      "",
      "   - `rationale`: ONE SHORT sentence, at most 15 words, plain language,",
      "     saying WHAT YOU CHANGED and nothing else. It is printed directly under",
      "     the new text with no way to fold it away, so every extra clause is paid",
      "     for on every row of the page. No query quotes, no case ids, no counts,",
      "     no evidence-tier names, no BM25, and do not restate what the tool does.",
      "     Write it for someone who has never seen this page before.",
      "   - `details`: the full audit, for a reader who opens it. Which searches",
      "     this fixes, the evidence tier behind each, and — if you shortened",
      "     anything — exactly which phrasings you dropped and why. Everything the",
      "     rules above demand you account for goes HERE, at whatever length it",
      "     honestly takes.",
      "",
      "   Give the expected effect in one line.",
      "",
      "2. Write a run-level read for a person who has thirty seconds:",
      "   - `headline`: ONE sentence, plain language, no jargon, naming the single",
      "     biggest thing wrong with this catalog's retrieval. Someone who knows",
      "     nothing about BM25 should understand it.",
      "   - `points`: two to four findings, each a short `title` and two or three",
      "     sentences of `detail`. Name the specific entries involved. Order them",
      "     by how much they cost. If the evidence is mostly the incumbent's",
      "     opinion, make one of the points say what that limits.",
      "",
      "   Write it as you would explain it to the engineer who owns this catalog,",
      "   not as a report. Concrete over comprehensive.",
    ].join("\n"),
  ];

  return { system: SYSTEM_PROMPT, user: sections.join("\n\n") };
}
