import type {
  CorpusEntry,
  JudgeCase,
  JudgeFraming,
  JudgeVerdict,
} from "@/lib/readings/decisions/judge";
import { JACCARD_THRESHOLD, tokenize } from "@/lib/readings/text/cluster";
import type { DistinctAsk } from "@/lib/readings/topics/asks";
import { bestOverlap } from "@/lib/readings/topics/group";
import { hashText, NONE_OPTION_ID } from "@/lib/readings/trace-signals/workflows/decide";

/**
 * Placing each distinct ask in a topic. The decision engine reads the ask and
 * picks a topic or "none of these"; its verdicts are cached per (ask, topic
 * set) in `trace_workflow_verdicts` under a `topics:` options hash, so a
 * project pays once per new ask or changed topic set. Where it is not
 * configured, or declines to call it, the ask goes where it went before, else
 * to the topic whose asks share the most words with it (at the clustering
 * bar), else nowhere. Pure.
 */

export const TOPIC_FRAMING: JudgeFraming = {
  about:
    "A message a person sent to an AI agent, or a search the agent made for a tool on their behalf. The options are the topics people ask this agent about.",
  question: "Which topic is this message about? Pick none if it fits no topic.",
};

/** Bump with the framing, so cached verdicts are asked again under the new wording. */
const TOPIC_FRAMING_VERSION = 1;

/** The verdict cache's namespace for topic placement. */
export const TOPIC_OPTIONS_PREFIX = "topics:";
/** The verdict cache's namespace for sentiment. */
export const SENTIMENT_OPTIONS_PREFIX = "topic-sentiment:";

export interface PlaceableTopic {
  topicId: string;
  name: string;
  description: string;
}

/** The options the decision engine chooses between: every topic by name and sentence, and "none". */
export function topicOptions(topics: readonly PlaceableTopic[]): CorpusEntry[] {
  return [
    ...topics.map((topic) => ({
      entryId: topic.topicId,
      name: topic.name,
      description: topic.description || topic.name,
      searchable: [topic.name, topic.description].filter(Boolean).join(". "),
      source: "description" as const,
      matchesAgentDescription: false,
      tags: [],
    })),
    {
      entryId: NONE_OPTION_ID,
      name: "None of these",
      description: "None of the topics above: the message asks about something else.",
      searchable: "none of these topics",
      source: "description" as const,
      matchesAgentDescription: false,
      tags: [],
    },
  ];
}

/** Changes whenever the option set does, so cached verdicts never outlive it. */
export function topicOptionsHash(
  options: readonly CorpusEntry[],
  prefix: string = TOPIC_OPTIONS_PREFIX,
  version = TOPIC_FRAMING_VERSION,
): string {
  return `${prefix}${hashText(JSON.stringify([version, options.map((o) => [o.entryId, o.name, o.description])]))}`;
}

/** One case per distinct ask, keyed by the ask's hash. */
export function askCases(asks: readonly Pick<DistinctAsk, "hash" | "text">[]): JudgeCase[] {
  return asks.map((ask) => ({
    id: ask.hash,
    query: ask.text,
    shortlist: [],
    assumed: "",
    stratum: "control",
  }));
}

/** A verdict's choice: a known option id, or null when the engine declined or chose something unknown. */
export function chosenOption(
  verdict: Pick<JudgeVerdict, "entryId"> | undefined,
  known: ReadonlySet<string>,
): string | null {
  const id = verdict?.entryId ?? "";
  return id !== "" && known.has(id) ? id : null;
}

/** What a topic's wording is read from: its name and sentence, and the asks known to belong to it. */
export interface TopicWording {
  topicId: string;
  members: ReadonlySet<string>[];
}

export function topicWording(
  topic: PlaceableTopic,
  memberAsks: readonly Pick<DistinctAsk, "tokens">[],
): TopicWording {
  // The name and the sentence count as two short asks of their own.
  const own = [new Set(tokenize(topic.name)), new Set(tokenize(topic.description))].filter(
    (tokens) => tokens.size > 0,
  );
  return { topicId: topic.topicId, members: [...own, ...memberAsks.map((ask) => ask.tokens)] };
}

/**
 * Where an ask goes by wording: the topic one of whose asks (or whose name)
 * shares the most content words with it, at or above `threshold`; null when
 * none does. Ties go to the topic listed first.
 */
export function placeByWords(
  ask: Pick<DistinctAsk, "tokens">,
  topics: readonly TopicWording[],
  threshold: number = JACCARD_THRESHOLD,
): string | null {
  let best: { topicId: string; overlap: number } | null = null;
  for (const topic of topics) {
    const overlap = bestOverlap(ask.tokens, topic.members);
    if (overlap >= threshold && (!best || overlap > best.overlap))
      best = { topicId: topic.topicId, overlap };
  }
  return best?.topicId ?? null;
}

/** Member asks a topic's wording keeps at most, busiest first. */
const MAX_WORDING_MEMBERS = 200;

/**
 * Every ask's topic: the known placements first (a verdict, or where the ask
 * went before), then the rest by wording against the topics as the known
 * placements fill them. Null means it fits none. `byWords` lists the asks the
 * wording placed (in a topic or in none).
 */
export function placeAsks(
  asks: readonly DistinctAsk[],
  topics: readonly PlaceableTopic[],
  known: ReadonlyMap<string, string | null>,
  threshold: number = JACCARD_THRESHOLD,
): { placed: Map<string, string | null>; byWords: Set<string> } {
  const active = new Set(topics.map((topic) => topic.topicId));
  const placed = new Map<string, string | null>();
  const members = new Map<string, DistinctAsk[]>(topics.map((topic) => [topic.topicId, []]));
  for (const ask of asks) {
    if (!known.has(ask.hash)) continue;
    const topicId = known.get(ask.hash) ?? null;
    if (topicId !== null && !active.has(topicId)) continue;
    placed.set(ask.hash, topicId);
    if (topicId !== null) {
      const list = members.get(topicId)!;
      if (list.length < MAX_WORDING_MEMBERS) list.push(ask);
    }
  }
  const wording = topics.map((topic) => topicWording(topic, members.get(topic.topicId) ?? []));
  const byWords = new Set<string>();
  for (const ask of asks) {
    if (placed.has(ask.hash)) continue;
    placed.set(ask.hash, placeByWords(ask, wording, threshold));
    byWords.add(ask.hash);
  }
  return { placed, byWords };
}
