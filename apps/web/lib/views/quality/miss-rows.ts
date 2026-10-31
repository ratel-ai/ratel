import type { Evidence, MissGroup, RankedList } from "./misses";
import type { SearchTest } from "./test-search";

/**
 * Misses as the client list needs them: plain, serializable rows with tool
 * names resolved and links built on the server, so the list and its panel
 * never reach back for data.
 */

/** The longest list shows this many results; a right tool further down is named below it. */
export const RANKED_ITEMS_SHOWN = 10;

/** More rows than this and the list says how many it left out (DESIGN.md, Lists). */
export const MAX_LISTED_MISSES = 200;

export interface ToolRef {
  id: string;
  name: string;
}

export interface RankedListView {
  /** The variant's name, as the experiment calls it. */
  arm: string;
  /** True when the agent was shown this list. */
  served: boolean;
  items: ToolRef[];
  /** Results beyond the ones listed. */
  more: number;
}

export interface MissRow {
  id: string;
  selectionIds: string[];
  query: string | null;
  expected: ToolRef;
  rankedFirst: ToolRef | null;
  /** Where we ranked the right tool, 1-based, or null when we did not return it. */
  rank: number | null;
  evidence: Evidence;
  count: number;
  /** ISO time of the latest sighting. */
  lastSeen: string;
  ours: RankedListView;
  comparison: RankedListView | null;
  /** Where the comparison variant ranked the right tool, when there is one. */
  comparisonRank: number | null;
  traceHref: string | null;
  /** How the search reopens in the Playground; null without its words or ids. */
  test: SearchTest | null;
  /** The right tool's description rewrite on Descriptions, when one is waiting or applied. */
  rewrite: "pending" | "applied" | null;
}

export interface MissRowLinks {
  /** A tool's display name; the id when the catalog no longer has it. */
  name: (entryId: string) => string;
  /** The run the latest sighting happened in, when its trace was kept. */
  traceHref: (group: MissGroup) => string | null;
  /** The Playground with the request prefilled. */
  test: (group: MissGroup) => SearchTest | null;
  /** The right tool's rewrite, if it has one. */
  rewrite: (entryId: string) => "pending" | "applied" | null;
}

export function toMissRows(groups: readonly MissGroup[], links: MissRowLinks): MissRow[] {
  return groups.slice(0, MAX_LISTED_MISSES).map((group) => {
    const { latest } = group;
    const first = latest.ours.resultIds[0];
    return {
      id: group.id,
      selectionIds: group.selectionIds,
      query: group.query,
      expected: tool(group.target, links),
      rankedFirst: first === undefined ? null : tool(first, links),
      rank: latest.rank,
      evidence: group.evidence,
      count: group.count,
      lastSeen: latest.occurredAt.toISOString(),
      ours: listView(latest.ours, links),
      comparison: latest.comparison ? listView(latest.comparison, links) : null,
      comparisonRank: latest.comparison ? rankOf(latest.comparison.resultIds, group.target) : null,
      traceHref: links.traceHref(group),
      test: links.test(group),
      rewrite: links.rewrite(group.target),
    };
  });
}

function rankOf(resultIds: readonly string[], id: string): number | null {
  const index = resultIds.indexOf(id);
  return index === -1 ? null : index + 1;
}

function tool(id: string, links: Pick<MissRowLinks, "name">): ToolRef {
  return { id, name: links.name(id) };
}

function listView(list: RankedList, links: Pick<MissRowLinks, "name">): RankedListView {
  return {
    arm: list.arm,
    served: list.served,
    items: list.resultIds.slice(0, RANKED_ITEMS_SHOWN).map((id) => tool(id, links)),
    more: Math.max(0, list.resultIds.length - RANKED_ITEMS_SHOWN),
  };
}
