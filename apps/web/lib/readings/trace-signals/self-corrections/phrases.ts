/**
 * Self-correction phrases in an assistant reply, for customers who send reply
 * text: apologies, concessions, retries, admissions and backtracks. Pure and
 * local: no model, no network. Each match carries its category, the canonical
 * phrase and its character range in the reply (end exclusive), so a surface
 * can highlight it later.
 *
 * Only the agent's own words count. Fenced code (closed or running to the
 * end), inline code (any number of backticks), block-quote lines and quoted
 * text (straight or curly quotes, within one paragraph) are skipped, so a
 * quoted user message or a string in code never matches.
 *
 * The same words can mean something else, and those uses are left out:
 * - "Actually," and "Wait," only when they open a sentence, comma included;
 *   "Correction:" when it opens one or follows a small adjective ("one quick
 *   correction:"), never inside a compound ("auto-correction:").
 * - "you're right to ask" validates the user and concedes nothing; "you're
 *   right on track", "you're right at the limit" place them. "You're right to
 *   point that out" still concedes.
 * - "I'm sorry to hear" is sympathy; "I'm sorry, but I can't" is a refusal.
 * - "Trying again won't help" is advice, not a retry.
 * - "Let me correct" needs the agent's own words as its object ("that",
 *   "myself", "the earlier answer"), not the user's file.
 * - Any phrase right after "if", "whether", "unless", a negation or "I don't
 *   think" is hypothetical or denied ("let me know if I made a mistake").
 * Words are matched whole, so "sorry" inside a longer word never counts.
 */

export const PHRASE_CATEGORIES = [
  "apology",
  "concession",
  "retry",
  "admission",
  "backtrack",
] as const;

export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number];

export interface PhraseMatch {
  category: PhraseCategory;
  /** The canonical phrase, however the reply cased or spelled it ("I’m sorry", "I am sorry": "I'm sorry"). */
  phrase: string;
  /** Character range in the reply, end exclusive. */
  start: number;
  end: number;
}

interface PhraseRule {
  category: PhraseCategory;
  phrase: string;
  /** Global and case-insensitive; words joined by `\s+` so a phrase may wrap a line. */
  pattern: RegExp;
  /** Must open a sentence (or follow one of `leads`). */
  opensSentence?: boolean;
  /** Words right before the phrase that let it stand without opening a sentence. */
  leads?: RegExp;
  /** What may not follow the phrase: the same words meaning something else. */
  unless?: RegExp;
}

const AP = "['’]";
/** How far back a lead-in is looked for, and how far ahead an exclusion. */
const LOOK_BACK = 40;
const LOOK_AHEAD = 60;

const SYMPATHY = String.raw`\s+(?:to\s+hear|for\s+your\s+loss|(?:that\s+)?you(?:${AP}re|\s+are)\s+(?:dealing|going|having|facing))`;
const REFUSAL = String.raw`,?\s*(?:but\s+)?I(?:\s+(?:can${AP}?t|cannot|can\s+not|am\s+(?:unable|not\s+able)|won${AP}t|don${AP}t\s+have)|${AP}m\s+(?:unable|not\s+able))\b`;
const NOT_AN_APOLOGY = new RegExp(`^(?:${SYMPATHY}|${REFUSAL})`, "i");
const REFUSING = new RegExp(`^(?:${REFUSAL})`, "i");
const NOT_A_CONCESSION =
  /^(?:-|\s+(?:to\s+(?!(?:point|flag|catch|question|call|notice)\b)|on\s+(?:track|time|schedule)\b|at\b|there\b|here\b|next\b|behind\b|around\b|where\b|now\b|back\b|up\b|in\s+(?:the|time)\b))/i;
const ADVICE = new RegExp(
  String.raw`^\s+(?:won${AP}t|will|would|may|might|could|should|can|can${AP}t|cannot|is|isn${AP}t|does|doesn${AP}t|did|didn${AP}t|later|usually|often|sometimes|helps?)\b`,
  "i",
);
const HYPOTHETICAL_OR_DENIED = new RegExp(
  String.raw`(?:\b(?:if|whether|unless|in\s+case)|\b(?:not|never|wasn${AP}t|isn${AP}t)|\b(?:don${AP}t|do\s+not|didn${AP}t|did\s+not)\s+(?:think|believe|say|mean|claim))\s+(?:that\s+)?$`,
  "i",
);
const CORRECTION_LEADS = /\b(?:a|one|small|quick|minor|slight|brief|tiny|important)\s+$/i;
const OWN_WORDS = String.raw`(?=\s+(?:that|this|myself|my|it|the\s+(?:previous|earlier|above|record)|what\s+I)\b|\s*[:.,;!]|\s*$)`;

function rule(
  category: PhraseCategory,
  phrase: string,
  source: string,
  extra: Partial<PhraseRule> = {},
): PhraseRule {
  return { category, phrase, pattern: new RegExp(source, "gi"), ...extra };
}

const RULES: readonly PhraseRule[] = [
  rule("apology", "I'm sorry", String.raw`\bI(?:${AP}m|\s+am)\s+sorry\b`, {
    unless: NOT_AN_APOLOGY,
  }),
  rule("apology", "I apologize", String.raw`\bI\s+apologi[sz]e\b`, { unless: REFUSING }),
  rule("apology", "Sorry about that", String.raw`\bsorry\s+about\s+that\b`),
  rule("apology", "My apologies", String.raw`\bmy\s+apologies\b`),
  rule(
    "concession",
    "You're absolutely right",
    String.raw`\byou(?:${AP}re|\s+are)\s+absolutely\s+right\b`,
    { unless: NOT_A_CONCESSION },
  ),
  rule("concession", "You're right", String.raw`\byou(?:${AP}re|\s+are)\s+right\b`, {
    unless: NOT_A_CONCESSION,
  }),
  rule("concession", "Good catch", String.raw`\bgood\s+catch\b`),
  rule("retry", "Let me try that again", String.raw`\blet\s+me\s+try\s+that\s+again\b`),
  rule("retry", "Let me try again", String.raw`\blet\s+me\s+try\s+again\b`),
  rule("retry", "Let me retry", String.raw`\blet\s+me\s+retry\b`),
  rule("retry", "Trying again", String.raw`\btrying\s+again\b`, { unless: ADVICE }),
  rule(
    "retry",
    "Let me try a different approach",
    String.raw`\blet\s+me\s+try\s+a\s+different\s+approach\b`,
  ),
  rule("admission", "I made a mistake", String.raw`\bI\s+made\s+a\s+mistake\b`),
  rule("admission", "My mistake", String.raw`\bmy\s+mistake\b`),
  rule("admission", "I was wrong", String.raw`\bI\s+was\s+wrong\b`),
  rule("admission", "I misread", String.raw`\bI\s+misread\b`),
  rule("admission", "That was incorrect", String.raw`\bthat\s+was\s+incorrect\b`),
  rule("backtrack", "Actually,", String.raw`\bactually,`, { opensSentence: true }),
  rule("backtrack", "On second thought", String.raw`\bon\s+second\s+thoughts?\b`),
  rule("backtrack", "Wait,", String.raw`\bwait,`, { opensSentence: true }),
  rule("backtrack", "Correction:", String.raw`\bcorrection:`, {
    opensSentence: true,
    leads: CORRECTION_LEADS,
  }),
  rule("backtrack", "Let me correct", String.raw`\blet\s+me\s+correct\b${OWN_WORDS}`),
];

// --- what is skipped ------------------------------------------------------------

type Range = readonly [start: number, end: number];

interface Line {
  start: number;
  end: number;
  body: string;
}

function linesOf(text: string): Line[] {
  let start = 0;
  return text.split("\n").map((body) => {
    const line = { start, end: start + body.length, body };
    start = line.end + 1;
    return line;
  });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Fenced code blocks, each through its closing fence or to the end of the text. */
function fenceRanges(lines: readonly Line[], textLength: number): Range[] {
  const ranges: Range[] = [];
  let open: { start: number; closing: RegExp } | null = null;
  for (const line of lines) {
    if (open) {
      if (open.closing.test(line.body)) {
        ranges.push([open.start, line.end]);
        open = null;
      }
      continue;
    }
    const fence = FENCE.exec(line.body)?.[1];
    // A backtick fence's info string has no backticks: "```x```" on one line is inline code.
    if (
      !fence ||
      (fence[0] === "`" && line.body.slice(line.body.indexOf(fence) + fence.length).includes("`"))
    )
      continue;
    open = {
      start: line.start,
      closing: new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`),
    };
  }
  return open ? [...ranges, [open.start, textLength]] : ranges;
}

const BLOCK_QUOTE = /^ {0,3}>/;

function blockQuoteRanges(lines: readonly Line[], skipped: Uint8Array): Range[] {
  return lines
    .filter((line) => skipped[line.start] !== 1 && BLOCK_QUOTE.test(line.body))
    .map((line) => [line.start, line.end] as const);
}

function maskOf(length: number, ranges: readonly Range[]): Uint8Array {
  const mask = new Uint8Array(length);
  for (const [start, end] of ranges) mask.fill(1, start, end);
  return mask;
}

/** Where the paragraph holding `at` ends: the next blank line, or the end of the text. */
function paragraphEnds(text: string): (at: number) => number {
  const blanks = [...text.matchAll(/\n[ \t]*\n/g)].map((m) => m.index);
  return (at) => blanks.find((blank) => blank >= at) ?? text.length;
}

const runLength = (text: string, at: number): number => {
  let n = 0;
  while (text[at + n] === "`") n += 1;
  return n;
};

/** Inline code: a run of backticks up to the next run of the same length in its paragraph; unmatched runs are literal. */
function inlineCodeRanges(
  text: string,
  skipped: Uint8Array,
  paragraphEnd: (at: number) => number,
): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < text.length) {
    if (skipped[i] === 1 || text[i] !== "`") {
      i += 1;
      continue;
    }
    const size = runLength(text, i);
    const until = paragraphEnd(i);
    let j = i + size;
    let close = -1;
    while (j < until && close === -1) {
      if (skipped[j] === 1 || text[j] !== "`") {
        j += 1;
        continue;
      }
      const n = runLength(text, j);
      if (n === size) close = j;
      j += n;
    }
    if (close === -1) {
      i += size;
      continue;
    }
    ranges.push([i, close + size]);
    i = close + size;
  }
  return ranges;
}

const LETTER = /\p{L}/u;

/** How each quote style closes; a curly apostrophe between letters ("you’re") never closes a quote. */
const QUOTE_CLOSERS: ReadonlyMap<string, (text: string, at: number) => boolean> = new Map([
  ['"', (text: string, at: number) => text[at] === '"'],
  ["“", (text: string, at: number) => text[at] === "”"],
  [
    "‘",
    (text: string, at: number) =>
      text[at] === "’" && !(LETTER.test(text[at - 1] ?? "") && LETTER.test(text[at + 1] ?? "")),
  ],
]);

/**
 * Quoted text, each quote closed within its paragraph; an unclosed quote hides
 * nothing. Once a style finds no closer before its paragraph ends, no later
 * opener of that style in the paragraph can either, so none looks again: one
 * pass, however many quotes are left open.
 */
function quoteRanges(
  text: string,
  skipped: Uint8Array,
  paragraphEnd: (at: number) => number,
): Range[] {
  const ranges: Range[] = [];
  const unclosedUntil = new Map<string, number>();
  let i = 0;
  while (i < text.length) {
    const opener = text[i]!;
    const closes = skipped[i] === 1 ? undefined : QUOTE_CLOSERS.get(opener);
    if (!closes || (unclosedUntil.get(opener) ?? -1) > i) {
      i += 1;
      continue;
    }
    const until = paragraphEnd(i);
    let j = i + 1;
    while (j < until && (skipped[j] === 1 || !closes(text, j))) j += 1;
    if (j >= until) {
      unclosedUntil.set(opener, until);
      i += 1;
      continue;
    }
    ranges.push([i, j + 1]);
    i = j + 1;
  }
  return ranges;
}

/** Every character the classifier does not read: code and quotes. */
function skippedMask(text: string): Uint8Array {
  const lines = linesOf(text);
  const paragraphEnd = paragraphEnds(text);
  const fences = fenceRanges(lines, text.length);
  const blocks = [...fences, ...blockQuoteRanges(lines, maskOf(text.length, fences))];
  const code = [...blocks, ...inlineCodeRanges(text, maskOf(text.length, blocks), paragraphEnd)];
  return maskOf(text.length, [
    ...code,
    ...quoteRanges(text, maskOf(text.length, code), paragraphEnd),
  ]);
}

// --- where a phrase stands ------------------------------------------------------

/** A line holding nothing before the phrase but a list marker and openers ("- ", "1. ", "**", "("). */
const LINE_OPENING = /^[ \t]*(?:(?:[-*+•]|\d+[.)])[ \t]+)?[*_~"'“‘([]*$/;
/** What may sit between a sentence's end and the next word: spaces, closing quotes and brackets, emphasis. */
const BETWEEN_SENTENCES = /[ \t"'“”‘’()[\]*_`~]/;

function opensSentence(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (LINE_OPENING.test(text.slice(lineStart, start))) return true;
  for (let i = start - 1; i >= lineStart; i -= 1) {
    const c = text[i]!;
    if (!BETWEEN_SENTENCES.test(c)) return /[.!?…]/.test(c);
  }
  return true;
}

function stands(
  rule: PhraseRule,
  text: string,
  start: number,
  end: number,
  skipped: Uint8Array,
): boolean {
  if (skipped.subarray(start, end).includes(1)) return false;
  const before = text.slice(Math.max(0, start - LOOK_BACK), start);
  if (HYPOTHETICAL_OR_DENIED.test(before)) return false;
  if (rule.unless?.test(text.slice(end, end + LOOK_AHEAD))) return false;
  if (rule.opensSentence && !opensSentence(text, start)) return rule.leads?.test(before) ?? false;
  return true;
}

/** Overlapping matches keep the one that starts first (the longer on a tie). */
function firstOfOverlaps(matches: readonly PhraseMatch[]): PhraseMatch[] {
  const ordered = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  return ordered.reduce<PhraseMatch[]>((kept, match) => {
    const last = kept.at(-1);
    return last && match.start < last.end ? kept : [...kept, match];
  }, []);
}

/** The self-correction phrases in an assistant reply, in text order. */
export function classifyReply(text: string): PhraseMatch[] {
  if (text.length === 0) return [];
  const skipped = skippedMask(text);
  const matches = RULES.flatMap((r) =>
    [...text.matchAll(r.pattern)].flatMap((m) => {
      const start = m.index;
      const end = start + m[0].length;
      return stands(r, text, start, end, skipped)
        ? [{ category: r.category, phrase: r.phrase, start, end }]
        : [];
    }),
  );
  return firstOfOverlaps(matches);
}
