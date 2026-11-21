import { createHash } from "node:crypto";
import { jaccard, tokenize } from "@/lib/readings/text/cluster";
import type { DistinctAsk } from "@/lib/readings/topics/asks";
import { groupByWording, type WordingGroup, wordsName } from "@/lib/readings/topics/group";
import {
  MAX_GROUP_ASKS,
  MAX_NAMING_GROUPS,
  type NamedTopic,
  type NamingGroup,
  nameInputHash,
} from "@/lib/readings/topics/name";
import { isAcknowledgement } from "@/lib/readings/topics/sentiment";
import {
  MAX_ACTIVE_TOPICS,
  MAX_NAMED_PER_RUN,
  NEW_TOPIC_MIN_SHARE,
  NEW_TOPIC_MIN_TURNS,
  type StoredTopic,
  TOPIC_WINDOW_DAYS,
} from "@/lib/readings/topics/types";

/**
 * How the set of topics changes from one reading to the next. Topic ids stay
 * stable: every topic is kept; a new one is added only when many asks fit
 * none ({@link topicFloor}: past {@link NEW_TOPIC_MIN_TURNS} turns and
 * {@link NEW_TOPIC_MIN_SHARE} of the asks, together); a topic is retired after
 * a full window with no asks. A model reads the unplaced asks grouped by
 * wording (the busiest groups, then one-off asks), joins groups that ask about
 * the same thing (to each other or to an existing topic) and names the new
 * topics (one call, at most twelve, each joining {@link NEW_TOPIC_MIN_TURNS}
 * turns or more); it also renames topics that still carry a name made from
 * their own words. Without one, each group past the floor is a topic named
 * from its own asks (`wordsName`). Deterministic given the namer's answer.
 */

const DAY_MS = 86_400_000;

export type Namer = (groups: NamingGroup[]) => Promise<NamedTopic[] | null>;

export interface EvolveInput {
  now: Date;
  /** Every stored topic, retired ones included. */
  topics: readonly StoredTopic[];
  /** Distinct asks of the reading's turns (retries left out), busiest first. */
  asks: readonly DistinctAsk[];
  /** Each ask's topic so far (null: it fits none). Asks missing here fit none. */
  placed: ReadonlyMap<string, string | null>;
  /** Turns with an ask, retries left out: what "many" is measured against. */
  askedTurns: number;
  /** The model namer; null without a key. */
  name: Namer | null;
  /** The model's name, stored on the topics it names. */
  model: string | null;
  /** The last naming call's input: the same input never pays for a second call. */
  lastNamingHash: string | null;
  /** A new topic's id from its seed (the busiest ask's hash); unique among `topics`. */
  newId: (seed: string) => string;
  /** False when the reading did not cover a full window (capped): nothing is retired. */
  fullWindow: boolean;
  windowDays?: number;
}

export interface EvolveResult {
  /** The topics placement reads from now on, oldest first. */
  active: StoredTopic[];
  created: StoredTopic[];
  renamed: StoredTopic[];
  retired: StoredTopic[];
  /** Asks this step placed: the members of new topics, and new groups joined to an existing topic. */
  assigned: Map<string, string>;
  naming: "model" | "words" | "none";
  /** The naming call's input hash, when one was made (or skipped as already asked). */
  namingHash: string | null;
  /** Whether the topics placement reads changed (ids, names or sentences). */
  changed: boolean;
}

function turnsByTopic(
  asks: readonly DistinctAsk[],
  placed: ReadonlyMap<string, string | null>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const ask of asks) {
    const topicId = placed.get(ask.hash);
    if (topicId) out.set(topicId, (out.get(topicId) ?? 0) + ask.turnIds.length);
  }
  return out;
}

/** The fewest turns a new topic holds, and the unplaced asks must hold before one is looked for. */
export function topicFloor(askedTurns: number): number {
  return Math.max(NEW_TOPIC_MIN_TURNS, Math.ceil(NEW_TOPIC_MIN_SHARE * askedTurns));
}

/**
 * The unplaced asks grouped by wording, busiest first, when there are many of
 * them (none below {@link topicFloor} in all). One-off asks are groups of
 * their own: phrased every which way, they are often one subject, which a
 * model can join into one topic.
 */
export function candidateGroups(
  asks: readonly DistinctAsk[],
  placed: ReadonlyMap<string, string | null>,
  askedTurns: number,
): WordingGroup[] {
  // "Ok thanks" closes a conversation; it is never what a topic is about.
  const unplaced = asks.filter((ask) => !placed.get(ask.hash) && !isAcknowledgement(ask.text));
  const turns = unplaced.reduce((sum, ask) => sum + ask.turnIds.length, 0);
  if (turns < topicFloor(askedTurns)) return [];
  return groupByWording(unplaced);
}

const hash = (material: unknown) =>
  createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);

const exampleAsks = (asks: readonly DistinctAsk[]) =>
  asks.slice(0, MAX_GROUP_ASKS).map((ask) => ask.text);

function wordsTopic(group: WordingGroup, id: string, now: Date): StoredTopic {
  return {
    topicId: id,
    name: wordsName(group.asks),
    description: "",
    labelSource: "words",
    model: null,
    inputHash: hash(["words", group.asks.slice(0, MAX_GROUP_ASKS).map((ask) => ask.key)]),
    retiredAt: null,
    createdAt: now,
  };
}

export async function evolveTopics(input: EvolveInput): Promise<EvolveResult> {
  const days = input.windowDays ?? TOPIC_WINDOW_DAYS;
  const turns = turnsByTopic(input.asks, input.placed);
  const oldEnough = input.now.getTime() - days * DAY_MS;
  const current = input.topics.filter((topic) => topic.retiredAt === null);
  const retired = input.fullWindow
    ? current
        .filter(
          (topic) =>
            (turns.get(topic.topicId) ?? 0) === 0 && topic.createdAt.getTime() <= oldEnough,
        )
        .map((topic) => ({ ...topic, retiredAt: input.now }))
    : [];
  const retiredIds = new Set(retired.map((topic) => topic.topicId));
  let active = current.filter((topic) => !retiredIds.has(topic.topicId));
  const assigned = new Map<string, string>();
  const created: StoredTopic[] = [];
  const renamed: StoredTopic[] = [];
  let room = Math.max(0, MAX_ACTIVE_TOPICS - active.length);

  const candidates = candidateGroups(input.asks, input.placed, input.askedTurns);
  const floor = topicFloor(input.askedTurns);
  const toRename = active.filter(
    (topic) => topic.labelSource === "words" && (turns.get(topic.topicId) ?? 0) > 0,
  );
  let naming: EvolveResult["naming"] = "none";
  let namingHash: string | null = null;

  const membersOf = (topicId: string) =>
    input.asks.filter((ask) => input.placed.get(ask.hash) === topicId);

  let named: NamedTopic[] | null = null;
  let groups: NamingGroup[] = [];
  let newGroups: WordingGroup[] = [];
  if (input.name && (candidates.length > 0 || toRename.length > 0)) {
    const shown = candidates.length > 0 ? active : toRename;
    const existing: NamingGroup[] = shown.slice(0, MAX_NAMING_GROUPS).map((topic) => ({
      topicId: topic.topicId,
      name: topic.labelSource === "words" ? null : topic.name,
      asks: exampleAsks(membersOf(topic.topicId)),
      turns: turns.get(topic.topicId) ?? 0,
    }));
    newGroups =
      room > 0 || existing.length > 0
        ? candidates.slice(0, Math.max(0, MAX_NAMING_GROUPS - existing.length))
        : [];
    groups = [
      ...existing,
      ...newGroups.map((group) => ({
        topicId: null,
        name: null,
        asks: exampleAsks(group.asks),
        turns: group.turns,
      })),
    ];
    namingHash = nameInputHash(groups);
    if (namingHash === input.lastNamingHash) {
      // Asked already with exactly this input: what it named then is in place, and the rest it left out.
      return finish({
        active,
        created,
        renamed,
        retired,
        assigned,
        naming: "none",
        namingHash,
        before: current,
      });
    }
    named = await input.name(groups);
    // A failed call is not an answer: the same input may be asked again.
    if (named === null) namingHash = null;
  }

  if (named) {
    naming = "model";
    const offset = groups.length - newGroups.length;
    for (const topic of named) {
      const existingIndex = topic.groups.find((index) => groups[index]?.topicId);
      const joined = topic.groups.flatMap((index) => {
        const group = index >= offset ? newGroups[index - offset] : undefined;
        return group ? [group] : [];
      });
      if (existingIndex !== undefined) {
        const target = active.find((item) => item.topicId === groups[existingIndex]!.topicId);
        if (!target) continue;
        for (const group of joined)
          for (const ask of group.asks) assigned.set(ask.hash, target.topicId);
        if (target.labelSource === "words") {
          const next = {
            ...target,
            name: topic.name,
            description: topic.description,
            labelSource: "llm" as const,
            model: input.model,
            inputHash: namingHash!,
          };
          renamed.push(next);
          active = active.map((item) => (item.topicId === next.topicId ? next : item));
        }
        continue;
      }
      const turnsJoined = joined.reduce((sum, group) => sum + group.turns, 0);
      if (
        joined.length === 0 ||
        turnsJoined < NEW_TOPIC_MIN_TURNS ||
        room <= 0 ||
        created.length >= MAX_NAMED_PER_RUN
      )
        continue;
      const id = input.newId(joined[0]!.key);
      const next: StoredTopic = {
        topicId: id,
        name: topic.name,
        description: topic.description,
        labelSource: "llm",
        model: input.model,
        inputHash: namingHash!,
        retiredAt: null,
        createdAt: input.now,
      };
      created.push(next);
      active = [...active, next];
      room -= 1;
      for (const group of joined) for (const ask of group.asks) assigned.set(ask.hash, id);
    }
  } else {
    // No model, or its answer was unusable: each big enough group is a topic named from its own asks,
    // and a group whose name says the same as a topic's ("Create a task in a project") joins that topic.
    for (const group of candidates) {
      if (group.turns < floor) continue;
      const draft = wordsTopic(group, "", input.now);
      const same = active.find((topic) => sameWords(topic.name, draft.name));
      if (same) {
        for (const ask of group.asks) assigned.set(ask.hash, same.topicId);
        continue;
      }
      if (room <= 0 || created.length >= MAX_NAMED_PER_RUN) continue;
      const next = { ...draft, topicId: input.newId(group.key) };
      created.push(next);
      active = [...active, next];
      room -= 1;
      for (const ask of group.asks) assigned.set(ask.hash, next.topicId);
    }
    naming = created.length > 0 ? "words" : "none";
  }

  return finish({
    active,
    created,
    renamed,
    retired,
    assigned,
    naming,
    namingHash,
    before: current,
  });
}

/** Two names that share nearly all their content words name one topic. */
function sameWords(a: string, b: string): boolean {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  return left.size > 0 && right.size > 0 && jaccard(left, right) >= SAME_NAME_JACCARD;
}

const SAME_NAME_JACCARD = 0.8;

function finish(state: {
  active: StoredTopic[];
  created: StoredTopic[];
  renamed: StoredTopic[];
  retired: StoredTopic[];
  assigned: Map<string, string>;
  naming: EvolveResult["naming"];
  namingHash: string | null;
  before: readonly StoredTopic[];
}): EvolveResult {
  // Oldest first: a stable order, so the decision engine's option set (and its cache) only changes with the topics.
  const order = [...state.active].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.topicId < b.topicId ? -1 : 1),
  );
  const signature = (topics: readonly StoredTopic[]) =>
    JSON.stringify(
      [...topics]
        .map((t) => [t.topicId, t.name, t.description])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
  return {
    active: order,
    created: state.created,
    renamed: state.renamed,
    retired: state.retired,
    assigned: state.assigned,
    naming: state.naming,
    namingHash: state.namingHash,
    changed: signature(state.active) !== signature(state.before),
  };
}
