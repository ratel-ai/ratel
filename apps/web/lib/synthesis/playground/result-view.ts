import type { PlaygroundRun } from "./run";
import type { CapabilityKind, RankedHit } from "./types";

/**
 * What a search result list SAYS, worked out once and kept pure so the words
 * on screen are testable: each row's place and how it moved, and the one
 * sentence that answers the page's question ("which tool would my agent pick,
 * and is it the one I expected?").
 */

export type Movement =
  | { kind: "same" }
  | { kind: "up"; places: number }
  | { kind: "down"; places: number }
  | { kind: "new" };

export interface ResultRow {
  hit: RankedHit;
  rank: number;
  /** Against the saved catalog. Null when nothing is changed, so there is nothing to compare. */
  movement: Movement | null;
  /** Rank with the saved descriptions, when it placed there. */
  savedRank: number | null;
  /** Score as a share of the first pick's, in [0, 1]. How close the race was. */
  strength: number;
}

export interface ResultList {
  kind: CapabilityKind;
  rows: ResultRow[];
  /** In the saved top results, pushed out by a change. */
  pushedOut: RankedHit[];
}

function bucketOf(kind: CapabilityKind): "skills" | "tools" {
  return kind === "skill" ? "skills" : "tools";
}

function movementOf(rank: number, savedRank: number | undefined): Movement {
  if (savedRank === undefined) return { kind: "new" };
  if (savedRank === rank) return { kind: "same" };
  return savedRank > rank
    ? { kind: "up", places: savedRank - rank }
    : { kind: "down", places: rank - savedRank };
}

/** The list a reader sees for one kind: the changed catalog when there are changes, the saved one otherwise. */
export function resultList(run: PlaygroundRun, kind: CapabilityKind): ResultList {
  const bucket = bucketOf(kind);
  const saved = run.baseline[bucket];
  const shown = run.hasEdits ? run.drafted[bucket] : saved;
  const savedRanks = new Map(saved.map((hit, index) => [hit.id, index + 1]));
  const top = shown.reduce((max, hit) => Math.max(max, hit.score), 0);
  const shownIds = new Set(shown.map((hit) => hit.id));

  return {
    kind,
    rows: shown.map((hit, index) => ({
      hit,
      rank: index + 1,
      movement: run.hasEdits ? movementOf(index + 1, savedRanks.get(hit.id)) : null,
      savedRank: savedRanks.get(hit.id) ?? null,
      strength: top > 0 ? Math.max(0, Math.min(1, hit.score / top)) : 0,
    })),
    pushedOut: run.hasEdits ? saved.filter((hit) => !shownIds.has(hit.id)) : [],
  };
}

/** A movement in a few words, for the row and for screen readers. */
export function movementWords(movement: Movement): string {
  switch (movement.kind) {
    case "same":
      return "Same place";
    case "new":
      return "New";
    case "up":
      return `Up ${movement.places}`;
    case "down":
      return `Down ${movement.places}`;
  }
}

export type Tone = "success" | "warning" | "neutral";

export interface Verdict {
  tone: Tone;
  text: string;
}

/**
 * The answer to "is the one I expected first?", in a few words. Null until the
 * reader names one: the list already shows the first pick, and a sentence
 * repeating it is text to read for nothing.
 */
export function verdict({
  list,
  expected,
  top,
  sharesWords,
}: {
  list: ResultList;
  expected: string | null;
  /** How many results the search asked for. */
  top: number;
  /** Whether the expected capability shares any word with the ask. */
  sharesWords: boolean;
}): Verdict | null {
  if (expected === null) return null;
  const row = list.rows.find((candidate) => candidate.hit.id === expected);
  // A change that moved it says where from, so one line tells the whole story.
  const was =
    row && row.movement && row.movement.kind !== "same"
      ? row.savedRank === null
        ? " (was not in the list)"
        : ` (was #${row.savedRank})`
      : "";
  if (row?.rank === 1) return { tone: "success", text: `${expected} comes first${was}.` };
  if (row) return { tone: "warning", text: `${expected} comes #${row.rank}${was}.` };
  return {
    tone: "warning",
    text: sharesWords
      ? `${expected} isn't in the top ${top}.`
      : `${expected} isn't in the top ${top}: no words in common with the ask.`,
  };
}

/**
 * What the reader's changes did, one sentence per changed capability that
 * this search can see (it placed before or after the change). Changed
 * capabilities this search never reaches are not mentioned: they did nothing
 * here, and listing them would bury the ones that did.
 */
export function changeSummary(
  list: ResultList,
  editedIds: ReadonlySet<string>,
  /** Already told by the verdict, so not told twice. */
  expected: string | null = null,
): Verdict[] {
  const summary: Verdict[] = [];
  for (const row of list.rows) {
    if (!editedIds.has(row.hit.id) || row.movement === null || row.hit.id === expected) continue;
    const id = row.hit.id;
    switch (row.movement.kind) {
      case "up":
        summary.push({
          tone: "success",
          text: `${id} moved up to #${row.rank} (was #${row.savedRank}).`,
        });
        break;
      case "new":
        summary.push({ tone: "success", text: `${id} now shows up at #${row.rank}.` });
        break;
      case "down":
        summary.push({
          tone: "warning",
          text: `${id} moved down to #${row.rank} (was #${row.savedRank}).`,
        });
        break;
      case "same":
        summary.push({ tone: "neutral", text: `${id} stayed at #${row.rank}.` });
        break;
    }
  }
  for (const hit of list.pushedOut) {
    if (editedIds.has(hit.id) && hit.id !== expected) {
      summary.push({ tone: "warning", text: `${hit.id} dropped out of the list.` });
    }
  }
  return summary;
}

/** Why a kind came back empty, in plain words. Null when it did not. */
export function emptyReason(
  list: ResultList,
  catalogSize: number,
  mode: "bm25" | "embeddings" | "hybrid",
  /** Whether matching by meaning is available here, so the advice never points at a switched-off control. */
  canMatchByMeaning: boolean,
): string | null {
  if (list.rows.length > 0) return null;
  const noun = list.kind === "skill" ? "skills" : "tools";
  if (catalogSize === 0) return `No ${noun} in this catalog yet.`;
  if (mode !== "bm25") return `No ${list.kind} could be scored for this ask.`;
  return canMatchByMeaning
    ? `No ${list.kind} shares a word with this ask. Try other words, or match by meaning.`
    : `No ${list.kind} shares a word with this ask.`;
}
