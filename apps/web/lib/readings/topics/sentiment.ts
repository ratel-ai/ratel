import type { CorpusEntry, JudgeFraming } from "@/lib/readings/decisions/judge";
import type { Sentiment } from "@/lib/readings/topics/types";

/**
 * How a person sounds in their own message: positive, neutral or negative.
 * Read only from the users' own words (a turn scope's message, an OTel
 * prompt), never from the searches an agent makes. The decision engine reads
 * it when one is configured; otherwise, and wherever it declines to call it,
 * this small lexicon does, in the open:
 *
 * - negative: clear frustration ("that's wrong", "not what I asked", "doesn't
 *   work", "still not", "useless", "broken" and the like);
 * - positive: clear thanks ("thanks", "perfect", "great" and the like);
 * - "again" on its own reads negative, unless the message also thanks;
 * - anything else is neutral.
 */

const STRONG_NEGATIVE = [
  "that's wrong",
  "that is wrong",
  "this is wrong",
  "wrong answer",
  "not what i asked",
  "not what i wanted",
  "not what i meant",
  "doesn't work",
  "does not work",
  "didn't work",
  "did not work",
  "not working",
  "still not",
  "still doesn't",
  "you didn't",
  "you missed",
  "you forgot",
  "incorrect",
  "useless",
  "broken",
  "frustrating",
  "frustrated",
  "annoying",
  "makes no sense",
  "try again",
] as const;

const POSITIVE = [
  "thanks",
  "thank you",
  "thx",
  "perfect",
  "great",
  "awesome",
  "excellent",
  "love it",
  "appreciate",
  "that worked",
  "works now",
  "exactly what",
  "nice one",
  "well done",
] as const;

const WEAK_NEGATIVE = ["again"] as const;

function pattern(phrases: readonly string[]): RegExp {
  const escaped = phrases.map((phrase) =>
    phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
  );
  return new RegExp(`(?:^|[^a-z0-9'])(?:${escaped.join("|")})(?=$|[^a-z0-9'])`, "i");
}

const STRONG_NEGATIVE_RE = pattern(STRONG_NEGATIVE);
const POSITIVE_RE = pattern(POSITIVE);
const WEAK_NEGATIVE_RE = pattern(WEAK_NEGATIVE);

/** The lexicon's reading of one message in the user's own words. */
export function lexiconSentiment(text: string): Sentiment {
  const flat = text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
  if (STRONG_NEGATIVE_RE.test(flat)) return "negative";
  if (POSITIVE_RE.test(flat)) return "positive";
  if (WEAK_NEGATIVE_RE.test(flat)) return "negative";
  return "neutral";
}

export const SENTIMENT_FRAMING: JudgeFraming = {
  about: "A message a person sent to an AI agent that works for them.",
  question: "How does the person sound in this message? Pick neutral for a plain request.",
};

/** Bump with the framing or the options, so cached readings are asked again. */
export const SENTIMENT_VERSION = 1;

function option(entryId: Sentiment, name: string, description: string): CorpusEntry {
  return {
    entryId,
    name,
    description,
    searchable: description,
    source: "description",
    matchesAgentDescription: false,
    tags: [],
  };
}

/** The three choices the decision engine reads a message against. */
export const SENTIMENT_OPTIONS: readonly CorpusEntry[] = [
  option(
    "positive",
    "Positive",
    "The person sounds pleased: they thank the agent or say the answer was right or helpful.",
  ),
  option("neutral", "Neutral", "A plain request or question with no sign of how the person feels."),
  option(
    "negative",
    "Negative",
    "The person sounds frustrated: they say the agent got it wrong, did not do what they asked, or that something still does not work.",
  ),
];

/** Words a closing message is made of ("ok thanks", "perfect, that's what I needed"). */
const ACKNOWLEDGEMENT_WORDS = new Set([
  "ok",
  "okay",
  "k",
  "thanks",
  "thank",
  "you",
  "thx",
  "ty",
  "perfect",
  "great",
  "awesome",
  "nice",
  "cool",
  "cheers",
  "good",
  "fine",
  "got",
  "it",
  "that",
  "that's",
  "thats",
  "what",
  "i",
  "needed",
  "appreciate",
  "it's",
  "so",
  "much",
  "very",
  "all",
  "sounds",
  "works",
  "worked",
  "done",
  "excellent",
  "brilliant",
  "lovely",
  "super",
  "a",
  "lot",
  "the",
  "help",
  "for",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .split(/[^a-z']+/)
    .filter(Boolean);
}

/**
 * A message that only closes the conversation ("ok thanks", "Perfect, thank
 * you"): no subject, so never a topic, though its sentiment still counts.
 */
export function isAcknowledgement(text: string): boolean {
  const list = words(text);
  return (
    list.length > 0 &&
    list.length <= 8 &&
    list.every((word) => ACKNOWLEDGEMENT_WORDS.has(word)) &&
    POSITIVE_RE.test(text.toLowerCase())
  );
}

/** Phrases that ask the agent to do its last answer over: "Try again?", "Still nothing? Try once more." */
const RETRY_REQUEST =
  /\b(?:try|check|run|do|look)(?: (?:it|that|this))? (?:again|once more)\b|\bone more time\b|\bretry\b|\bstill nothing\b|^again\b/;

/**
 * A short message that only asks the agent to try its last answer again: the
 * same question, asked again without repeating it.
 */
export function isRetryRequest(text: string): boolean {
  const flat = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return words(flat).length <= 10 && RETRY_REQUEST.test(flat);
}

export function isSentiment(value: string): value is Sentiment {
  return value === "positive" || value === "neutral" || value === "negative";
}
