import {
  ANAPHOR,
  ARTICLES,
  type ArgumentSlot,
  identifierWords,
  maskArguments,
  stem,
  type VerbLexicon,
} from "@/lib/readings/intent-engine/text";

/**
 * Read an ask as the requests it holds: one frame per action it asks for,
 * each with the action, the thing acted on and the values it names. Search
 * queries an agent writes rarely join their requests with "and" ("create task
 * comment on task list tasks in project"), so a frame starts at every action
 * head, not only at a coordinator.
 *
 * An action head is an action verb (the base list plus the catalog's tool
 * verbs) or a tool id that starts with one (`create_task`). A verb is read as
 * a noun, and starts no frame, when:
 *   - it follows its frame's verb before any object ("add comment", "delete or remove a link");
 *   - an article, a possessive or a preposition comes right before it ("check the test", "filter by update");
 *   - it is a purpose clause ("… to create a task");
 *   - it is plural, or a participle inside a phrase ("the CI tests", "a document linked to a project");
 *   - a catalog tool led by the frame's verb names it ("add a progress comment": `add_task_comment`).
 * A frame with no object, or one that points back ("fix the failed ones"),
 * borrows the object before it and is marked synthetic: matched on, never stored.
 *
 * Rules only, from the project's own catalog and a domain-free word list.
 */

export interface Frame {
  text: string;
  /** The stemmed action verb, or null for an ask with none. */
  action: string | null;
  /** The stemmed thing acted on, or null. */
  object: string | null;
  slots: ArgumentSlot[];
  /** True when the text was rewritten (an object carried over): match on it, never store it. */
  synthetic: boolean;
  head: "verb" | "tool_id" | "none";
}

export const MAX_FRAMES = 4;

const COORDINATORS = new Set(["and", "then", "also", "plus", "&"]);
/** Words after which a verb is the noun: "the test", "my update", "by comment", "to create". */
const NOUN_BEFORE = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "my",
  "our",
  "your",
  "its",
  "their",
  "his",
  "her",
  "each",
  "every",
  "some",
  "any",
  "all",
  "no",
  "new",
  "existing",
  "another",
  "other",
  "of",
  "for",
  "with",
  "by",
  "in",
  "on",
  "from",
  "into",
  "onto",
  "about",
  "at",
  "via",
  "under",
  "without",
  "per",
  "as",
  "to",
]);
const PREPOSITIONS = new Set([
  "of",
  "for",
  "with",
  "by",
  "in",
  "on",
  "from",
  "into",
  "onto",
  "about",
  "at",
  "via",
  "under",
  "without",
  "per",
  "as",
  "to",
]);
const TOOL_ID =
  /^(?:[a-z][a-z0-9]*(?:__|::|[./:]))*[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[a-z]+(?:[A-Z][a-z0-9]+)+$/;
const TRAILING_JOINERS = /(?:[\s,;:]+|\s+(?:and|then|also|plus|or|&))+$/i;

interface Token {
  raw: string;
  word: string;
  term: string;
  /** A comma, semicolon or sentence end follows it. */
  breakAfter: boolean;
  /** The words of a tool id written into the ask, namespace dropped. */
  toolWords: string[] | null;
}

interface Head {
  at: number;
  action: string;
  kind: "verb" | "tool_id";
  /** For a tool id: what the id names as acted on. */
  idObject: string | null;
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const core = raw.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
      const toolWords = TOOL_ID.test(core)
        ? identifierWords(core.split(/__|::|[./:]/).pop() ?? core)
        : null;
      const word = core.toLowerCase();
      return { raw, word, term: stem(word), breakAfter: /[,;.!?]$/.test(raw), toolWords };
    });
}

/** The frames an ask holds: one, unchanged, unless it asks for two or more actions. */
export function extractFrames(text: string, verbs: VerbLexicon): Frame[] {
  const tokens = tokenize(text);
  const heads: Head[] = [];
  let atBoundary = true;
  let objectSeen = false;
  let previousWord = "";
  let contentSeen = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.word) continue;
    if (COORDINATORS.has(t.word) || (t.word === "after" && tokens[i + 1]?.word === "that")) {
      if (t.word === "after") i += 1;
      atBoundary = true;
      previousWord = t.word;
      continue;
    }
    // "delete or remove": an alternative, not a second request; the words around it decide.
    if (t.word === "or" || t.word === "/") {
      previousWord = t.word;
      continue;
    }
    const current = heads[heads.length - 1];
    const toolVerb =
      t.toolWords && t.toolWords.length > 1 && verbs.has(stem(t.toolWords[0]))
        ? stem(t.toolWords[0])
        : null;
    const isVerb = toolVerb !== null || (!t.toolWords && verbs.has(t.term));
    let startsFrame = false;
    if (isVerb) {
      if (!current) {
        // The first action, unless it reads as a noun: "the tests are failing", "CI tests".
        const afterArticle = NOUN_BEFORE.has(previousWord) && previousWord !== "to";
        startsFrame =
          toolVerb !== null || !(afterArticle || (contentSeen && /[^s]s$/.test(t.word)));
      } else {
        const noun =
          !objectSeen ||
          NOUN_BEFORE.has(previousWord) ||
          (toolVerb === null && /[^s]s$/.test(t.word)) ||
          (!atBoundary && /(?:ed|ing)$/.test(t.word)) ||
          (!atBoundary && verbs.actsOn(current.action, t.term)) ||
          // The last word of a phrase, with nothing left to act on: "post progress comment".
          (!atBoundary && !tokens.slice(i + 1).some((n) => n.word && !NOUN_BEFORE.has(n.word)));
        startsFrame = !noun;
      }
    }
    if (startsFrame) {
      heads.push({
        at: i,
        action: toolVerb ?? t.term,
        kind: toolVerb !== null ? "tool_id" : "verb",
        idObject: toolVerb !== null ? verbs.headObject(t.toolWords!.slice(1).join(" ")) : null,
      });
      objectSeen = toolVerb !== null;
    } else if (heads.length > 0 && !PREPOSITIONS.has(t.word)) {
      objectSeen = objectSeen || !NOUN_BEFORE.has(t.word);
    }
    if (!NOUN_BEFORE.has(t.word)) contentSeen = true;
    atBoundary = t.breakAfter;
    previousWord = t.word;
  }

  if (heads.length === 0) {
    return [
      {
        text,
        action: null,
        object: verbs.headObject(text),
        slots: maskArguments(text).slots,
        synthetic: false,
        head: "none",
      },
    ];
  }
  if (heads.length === 1) {
    const h = heads[0];
    const own = tokens
      .slice(h.at)
      .map((t) => t.raw)
      .join(" ");
    return [
      {
        text,
        action: h.action,
        object: h.idObject ?? objectOf(own, h.action, verbs),
        slots: maskArguments(text).slots,
        synthetic: false,
        head: h.kind,
      },
    ];
  }

  // More actions than frames kept: the rest stay with the last frame.
  const kept = heads.slice(0, MAX_FRAMES);
  const frames: Frame[] = [];
  let previousPhrase = "";
  let previousObject: string | null = null;
  for (let k = 0; k < kept.length; k += 1) {
    const h = kept[k];
    const end = k + 1 < kept.length ? kept[k + 1].at : tokens.length;
    const words = tokens.slice(h.at, end);
    const segment = words
      .map((t) => t.raw)
      .join(" ")
      .replace(TRAILING_JOINERS, "");
    const phrase = objectPhrase(words.slice(1));
    let object = h.idObject ?? objectOf(segment, h.action, verbs);
    let frameText = segment;
    let synthetic = false;
    if (previousPhrase && ANAPHOR.test(segment)) {
      frameText = segment.replace(ANAPHOR, previousPhrase);
      object = previousObject;
      synthetic = true;
    } else if (!object) {
      if (!previousPhrase) {
        frames.push({
          text: segment,
          action: h.action,
          object,
          slots: maskArguments(segment).slots,
          synthetic: false,
          head: h.kind,
        });
        continue;
      }
      frameText = `${segment} ${previousPhrase}`;
      object = previousObject;
      synthetic = true;
    }
    if (!synthetic) {
      previousPhrase = phrase;
      previousObject = object;
    }
    frames.push({
      text: frameText,
      action: h.action,
      object,
      slots: maskArguments(frameText).slots,
      synthetic,
      head: h.kind,
    });
  }
  return frames;
}

/**
 * The thing a frame acts on: the lexicon's head object, else its last term
 * other than the action, for an object that is also a verb ("remove a link").
 */
function objectOf(text: string, action: string, verbs: VerbLexicon): string | null {
  return (
    verbs.headObject(text) ??
    verbs
      .objectTerms(text)
      .filter((t) => t !== action)
      .pop() ??
    null
  );
}

/**
 * What a frame's verb acts on, as written: from its first object word up to
 * the next preposition or break, articles dropped ("comment on task" → "task").
 */
function objectPhrase(words: readonly Token[]): string {
  const out: string[] = [];
  for (const t of words) {
    if (out.length === 0 && NOUN_BEFORE.has(t.word)) continue;
    if (PREPOSITIONS.has(t.word) || COORDINATORS.has(t.word)) break;
    out.push(t.raw.replace(/[,;.!?:]+$/, ""));
    if (t.breakAfter) break;
  }
  return out.join(" ").replace(ARTICLES, "").trim();
}
