import type { IntentBreakdown } from "@/lib/views/intents/breakdown";

/**
 * One intent's asks as a tree for Intents › Map's Asks lens: what they ask
 * for, each with the ways people ask it, every node sized by its asks. Built
 * from the breakdown (`./breakdown.ts`) without its samples or splits, so it
 * stays small enough to read for every intent at once. What was not listed
 * keeps its asks as a rest, so the sizes stay true to the whole. Labels are
 * asks as written (or a model's names): text for the page, never logs,
 * events or attributes.
 */

export interface AsksTreeWay {
  id: string;
  /** The way's most typical ask, as written. */
  label: string;
  asks: number;
}

export interface AsksTreeGroup {
  id: string;
  /** A model's name, or (when `quoted`) the group's busiest ask as written. */
  label: string;
  quoted: boolean;
  asks: number;
  /** Its ways, most asked first; one way alone is none (the level is skipped). */
  ways: AsksTreeWay[];
  /** The asks of the ways not listed, and how many ways they are. */
  restAsks: number;
  restWays: number;
}

export interface IntentAsksTree {
  topicId: string;
  /** Its asks the engine placed in its own groups. */
  asks: number;
  /** Its asks read for the breakdown, and whether that was its newest only (a busy window). */
  read: number;
  capped: boolean;
  /** One thing only: its one group's ways stand for the intent. */
  skipped: boolean;
  groups: AsksTreeGroup[];
  /** The asks of the groups not listed, and how many groups they are. */
  restAsks: number;
  restGroups: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export function asksTree(breakdown: IntentBreakdown): IntentAsksTree {
  const { groups, more, skipped } = breakdown.whatTheyAskFor;
  const own = Math.max(0, breakdown.placed - breakdown.elsewhere.asks);
  const listed: AsksTreeGroup[] = groups.map((group) => {
    const ways = group.waysOfAsking.skipped
      ? []
      : group.waysOfAsking.ways.map((way) => ({ id: way.id, label: way.label, asks: way.asks }));
    return {
      id: group.id,
      label: group.label,
      quoted: group.quoted,
      asks: group.asks,
      ways,
      restAsks: ways.length === 0 ? 0 : Math.max(0, group.asks - sum(ways.map((way) => way.asks))),
      restWays: ways.length === 0 ? 0 : group.waysOfAsking.more,
    };
  });
  return {
    topicId: breakdown.topicId,
    asks: own,
    read: breakdown.asks,
    capped: breakdown.capped,
    skipped,
    groups: listed,
    restAsks: more > 0 ? Math.max(0, own - sum(listed.map((group) => group.asks))) : 0,
    restGroups: more,
  };
}
