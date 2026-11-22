import { createHash } from "node:crypto";
import { ToolRegistry } from "@ratel-ai/sdk";

/**
 * The judge contract the readings share: a closed-set question ("which of these entries
 * was this ask for?") put to a decision engine, and the engine-neutral helpers around it.
 *
 * WHO JUDGES. A `JudgeEngine`. This file owns what a case and a verdict are; an engine
 * owns only how a verdict is reached (`openai-judge.ts` here). Every engine must be able
 * to answer with an entry the caller did not shortlist, because "none of the obvious ones"
 * is the most valuable verdict there is, and must be able to abstain, because a two-word
 * ambiguous ask should drop out rather than mint a coin-flip answer.
 *
 * Owned (ADR-0030): the contract, the corpus entry and the option, verdict and ordering
 * helpers of upstream's match-quality judge modules. The sampling, the census and the
 * verdict application land with the match-quality reading.
 */

/** What one question tells the engine: the situation and the question. */
export interface JudgeFraming {
  about: string;
  question: string;
}

/** The tuned tool-search framing. Changing a word here is a re-benchmark, not a copy edit. */
export const TOOL_SEARCH_ABOUT =
  "An AI agent typed this query into a tool search to find the tool it will call next.";
export const TOOL_SEARCH_QUESTION = {
  question: "Which tool should the agent call next to do what this search query asks?",
};

/**
 * Below this confidence the engine abstains and the ask is stored unclear. Calibrated
 * against a three-model panel on tool identity: at 0.8 the engine agrees with the panel
 * on about 96% of the two thirds of asks it answers.
 */
export const JUDGE_MIN_CONFIDENCE = 0.8;

/** Above this a verdict is stored as confident. */
export const JUDGE_CONFIDENT = 0.9;

/**
 * Options per question. The question (options plus descriptions) shares a bounded token
 * budget with the framing, and accuracy falls as irrelevant options pile up. A bigger
 * catalog is narrowed first.
 */
export const JUDGE_MAX_OPTIONS = 150;

/** Characters kept per description field, so one verbose entry cannot crowd out the rest. */
export const JUDGE_MAX_FIELD_CHARS = 600;

/**
 * Characters of option text per question, about 20k tokens. A 100-tool catalog with both
 * descriptions runs about 35k characters.
 */
export const JUDGE_MAX_OPTION_CHARS = 80_000;

/**
 * Wall-clock time one run may spend judging before it stops asking. The job reaper marks
 * anything running for ten minutes as timed out, and the caller still has work after
 * this, so judging gets half of that; what is left over is judged next run.
 */
export const JUDGE_MAX_DURATION_MS = 5 * 60 * 1000;

export type JudgeStratum = "disputed" | "control";

/** One ask put to the judge. */
export interface JudgeCase {
  /** The caller's id for the ask, so a verdict can be matched back. */
  id: string;
  query: string;
  /** Entry ids the caller wants kept in the options whatever the narrowing. Never labelled by source. */
  shortlist: string[];
  /** What the caller assumed the answer was. Never sent; used only for calibration. */
  assumed: string;
  stratum: JudgeStratum;
}

export interface JudgeVerdict {
  id: string;
  /** Empty when the judge declined to call it. */
  entryId: string;
  confident: boolean;
  /** The engine's confidence in [0, 1], when it has one. */
  confidence?: number;
  /** The engine's second choice, when it has one: what this ask is confused with. */
  runnerUp?: string;
}

/**
 * Anything that can decide which entry an ask was for.
 *
 * Contract: one verdict per case id; an entry id the corpus does not hold is an
 * abstention, never an answer; an empty `entryId` is an abstention, and abstaining is
 * always allowed. An engine may leave cases out entirely, for instance when it hits its
 * own spending or time limit. An engine that cannot judge at all should throw, so the
 * caller logs one failure instead of silently reporting that nothing needed judging.
 */
export interface JudgeEngine {
  /** Stored on every verdict the caller keeps. */
  model: string;
  judge(cases: readonly JudgeCase[], corpus: readonly CorpusEntry[]): Promise<JudgeVerdict[]>;
  /**
   * How many cases this engine can afford over this corpus in one run, from its own
   * budget and price. Absent means no limit beyond the caller's caps.
   */
  capacity?(corpus: readonly CorpusEntry[]): number;
}

/** One catalog entry as a corpus sees it: the options an engine chooses between. */
export interface CorpusEntry {
  entryId: string;
  name: string;
  searchable: string;
  /**
   * What the agent is told the tool does, when it differs from `searchable`. Optional
   * because only the loader reads it from the catalog; fixtures build entries without
   * it, and the judge falls back to `searchable`.
   */
  description?: string;
  /**
   * The searchable text the project's SDK sent, BEFORE any operator override. With
   * `description` this is the tool's identity: what the judge reads, so a rewrite an
   * operator applies can never make the judge agree with that rewrite.
   */
  runtimeSearchable?: string;
  /** "override" | "runtime" | "description": where `searchable` came from. */
  source: string;
  /** True when the searchable text is the agent description verbatim. */
  matchesAgentDescription: boolean;
  tags: string[];
}

/** One engine answer: the chosen id, its confidence and the distribution over options. */
export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Text an index can hold: a trimmed string, or nothing. */
export function indexableText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A fingerprint of what the tools ARE: ids, names, agent descriptions and the searchable
 * text the project's SDK sent. Deliberately NOT operator overrides.
 *
 * A verdict is stored with the fingerprint it was made against. When the tools change
 * (one added, one removed, a description edited) older verdicts go stale and are re-read
 * as budget allows. Applying a searchable-text override does NOT change it, because the
 * judge never reads overrides.
 */
export function identityFingerprint(corpus: readonly CorpusEntry[]): string {
  const rows = corpus
    .map((entry) =>
      [entry.entryId, entry.name, entry.description ?? "", entry.runtimeSearchable ?? ""].join(
        "\u0000",
      ),
    )
    .sort();
  return createHash("sha256").update(rows.join("\u0001")).digest("hex").slice(0, 32);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > JUDGE_MAX_FIELD_CHARS
    ? `${flat.slice(0, JUDGE_MAX_FIELD_CHARS - 1)}…`
    : flat;
}

/**
 * What the engine reads about one entry: what it IS, never what an operator rewrote.
 *
 * The agent-facing description and the searchable text the project's SDK sent. Not
 * `searchable`, which carries the operator's override when there is one: those overrides
 * exist to make search find a tool, and a judge that read them would agree with every
 * rewrite by construction. The agent picks tools from the agent description too, so this
 * is also the text that decides what the agent does.
 */
export function identityCriteria(entry: CorpusEntry): { does: string; searchable: string } {
  const sdk = entry.runtimeSearchable || entry.description || entry.searchable;
  return {
    does: clip(entry.description || sdk),
    searchable: clip(sdk),
  };
}

function optionChars(entry: CorpusEntry): number {
  const text = identityCriteria(entry);
  return entry.entryId.length + text.does.length + text.searchable.length;
}

/**
 * The entries one ask is asked to choose between.
 *
 * The whole corpus when it fits, because an answer outside the shortlist has to stay
 * reachable. Past the caps (count or total text): the shortlist first, then BM25's order
 * over the query, until a cap is hit. Narrowing by BM25 costs the judge the entries that
 * share no words with the query, which is a real blind spot and the reason the caps sit
 * well above any catalog seen so far.
 */
export function judgeOptions(
  row: Pick<JudgeCase, "query" | "shortlist">,
  corpus: readonly CorpusEntry[],
  bm25: (query: string, depth: number) => string[],
  max: number = JUDGE_MAX_OPTIONS,
  maxChars: number = JUDGE_MAX_OPTION_CHARS,
): CorpusEntry[] {
  const total = corpus.reduce((sum, entry) => sum + optionChars(entry), 0);
  if (corpus.length <= max && total <= maxChars) return [...corpus];
  const byId = new Map(corpus.map((entry) => [entry.entryId, entry]));
  const picked = new Map<string, CorpusEntry>();
  let chars = 0;
  for (const id of [...row.shortlist, ...bm25(row.query, max)]) {
    const entry = byId.get(id);
    if (!entry || picked.has(id)) continue;
    const size = optionChars(entry);
    if (picked.size >= max || chars + size > maxChars) break;
    picked.set(id, entry);
    chars += size;
  }
  return [...picked.values()];
}

/** Read one answer into a verdict. Abstains below the threshold. */
export function verdictFrom(
  id: string,
  answer: ChoiceAnswer | undefined,
  minConfidence: number = JUDGE_MIN_CONFIDENCE,
): JudgeVerdict {
  if (!answer || typeof answer.choice !== "string") return { id, entryId: "", confident: false };
  if (!(answer.confidence >= minConfidence)) {
    // Unclear, but the split is worth keeping: an unclear ask is usually two entries the
    // catalog does not tell apart, and that pair is a problem to fix.
    return {
      id,
      entryId: "",
      confident: false,
      confidence: answer.confidence,
      ...(typeof answer.choice === "string" ? { runnerUp: answer.choice } : {}),
    };
  }
  return {
    id,
    entryId: answer.choice,
    confident: answer.confidence >= JUDGE_CONFIDENT,
    confidence: answer.confidence,
    ...runnerUpOf(answer),
  };
}

function runnerUpOf(answer: ChoiceAnswer): { runnerUp?: string } {
  const ranked = Object.entries(answer.probabilities ?? {})
    .filter(([id]) => id !== answer.choice)
    .sort((left, right) => right[1] - left[1]);
  const second = ranked[0];
  return second && second[1] > 0 ? { runnerUp: second[0] } : {};
}

/**
 * The SDK's own BM25 order over a corpus, for a caller that has to narrow it before
 * handing it on: the judge, when a catalog outgrows what one question can carry. Built
 * once, queried per ask.
 *
 * An entry whose searchable text or name is empty is skipped, not registered with a
 * placeholder: BM25 cannot return a document with no terms, so such an entry is
 * unreachable in production too, and a placeholder would invent index terms nothing
 * matches on.
 */
export function bm25Order(
  entries: readonly CorpusEntry[],
): (query: string, depth: number) => string[] {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    if (indexableText(entry.searchable).length === 0 || indexableText(entry.name).length === 0) {
      continue;
    }
    // `register` is declared async but indexes in-process; awaiting per entry would
    // serialize a hundred no-op microtasks for nothing.
    void registry.register({
      id: entry.entryId,
      name: entry.name,
      description: entry.searchable,
      // Observed entries carry no synced schema; an open object keeps the shape valid
      // without asserting parameters we do not actually know.
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  }
  return (query, depth) =>
    registry.searchWithOrigin(query, depth, "agent").map((hit) => hit.toolId);
}
