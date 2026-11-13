/**
 * The engine's levels under our Intents: for each Intent (topic), "What they
 * ask for" (level-1 groups, one action on one thing) and, per group, "Ways
 * people ask it" (level-0 clusters, with sample asks and true counts), plus
 * the other Intents wanted in the same ask ("Also wants").
 *
 * The unit is our Intents' own: one ask per turn, the one the topic reading
 * placed the turn by (`trace_turn_topics.ask_source`). The engine places that
 * ask's frames (an ask wanting two things has two); the join reads them back
 * through the turn (`./breakdown-queries.ts`). Then:
 *
 *   - a level-1 group belongs to the Intent most of its asks' turns are in
 *     (each ask votes once per group it touches); its asks in other Intents
 *     are kept as split counts (`alsoIn`);
 *   - an ask counts once, in its turn's Intent, under its main frame: the
 *     first frame whose group belongs to that Intent, else its first frame.
 *     When that group belongs elsewhere the ask is counted in `elsewhere`;
 *   - any other frame whose group belongs to another Intent makes "Also wants
 *     {that Intent}", once per ask and Intent;
 *   - a level with a single child is skipped: `whatTheyAskFor.skipped` when
 *     the Intent has one group, `waysOfAsking.skipped` when a group has one
 *     way. The child is still there, for the reader to show in its place;
 *   - a group reads as the name a model wrote for it, else as its busiest way
 *     of asking here: an ask as written, for the page to quote. A rule-made
 *     name stays the engine's own: from asks shaped like commands it reads
 *     well ("Create task"), from people's sentences it does not ("Install
 *     Eastside").
 *
 * Level-1 ids reshuffle when the engine rebuilds; nothing should key lasting
 * state on them (topic ids are the stable keys). Pure: no I/O, no clock.
 * Samples and quoted labels are raw ask text: they go to the page, never to
 * logs or events.
 */
import { centralPhrases } from "@/lib/readings/intent-engine/naming";

/** One turn's ask as the engine placed it. */
export interface PlacedAsk {
  topicId: string;
  /** The ask's frames, `ask_index` order: the level-0 cluster each landed in. */
  clusters: readonly string[];
}

export interface BreakdownInput {
  /** Per Intent: turns with an ask in the window read, placed by the engine or not. */
  asksByTopic: ReadonlyMap<string, number>;
  /** The asks the engine placed (a turn whose ask it never read is absent). */
  asks: readonly PlacedAsk[];
  /** Level-0 cluster: its level-1 parent and its name. */
  clusters: ReadonlyMap<string, { parentId: string | null; label: string }>;
  /** Level-1 group: its name and whether a model wrote it. */
  groups: ReadonlyMap<string, { label: string; named: boolean }>;
  /** The Intents whose window held more turns than were read. */
  capped: ReadonlySet<string>;
}

export interface WayOfAsking {
  /** Level-0 cluster id. */
  id: string;
  /** Its most typical ask, as written. */
  label: string;
  /** This Intent's asks that came this way: "12 of 48". */
  asks: number;
  /** The group's asks in this Intent. */
  of: number;
  /** Sample asks of the cluster, newest first; filled by the loader. */
  samples: string[];
}

export interface AskForGroup {
  /** Level-1 group id; reshuffles across rebuilds. */
  id: string;
  /** The name a model wrote, or with none its busiest way of asking here. */
  label: string;
  /** Whether a model wrote the label. */
  named: boolean;
  /** The label is an ask as written, to be quoted: no model has named the group yet. */
  quoted: boolean;
  /** This Intent's asks whose main frame is this group. */
  asks: number;
  /** `asks` over this Intent's placed asks. */
  share: number;
  /** Its asks in every Intent; more than `asks` when it spans Intents. */
  totalAsks: number;
  /** Its asks in other Intents, most first: the split when it spans them. */
  alsoIn: Array<{ topicId: string; asks: number }>;
  waysOfAsking: {
    /** One way only: the level is skipped and its one way stands for the group. */
    skipped: boolean;
    ways: WayOfAsking[];
    /** Ways not listed. */
    more: number;
  };
}

export interface IntentBreakdown {
  topicId: string;
  /** Turns with an ask in this Intent, in the window read. */
  asks: number;
  /** Of those, the ones the engine placed in a group. */
  placed: number;
  capped: boolean;
  whatTheyAskFor: {
    /** One group only: the level is skipped and its ways stand for the Intent. */
    skipped: boolean;
    groups: AskForGroup[];
    /** Groups not listed. */
    more: number;
  };
  /** Asks of this Intent whose group belongs to another Intent. */
  elsewhere: {
    asks: number;
    groups: Array<{ id: string; label: string; topicId: string; asks: number }>;
  };
  /** Other Intents wanted in the same ask, most first, counted once per ask. */
  alsoWants: Array<{ topicId: string; asks: number; share: number }>;
}

/** A row an All intents chevron opens: a "What they ask for" group, or a way of asking when that level is skipped. */
export interface BreakdownRow {
  id: string;
  kind: "group" | "way";
  /** A group's name, or an ask as written when `quoted` (text, never an attribute). */
  label: string;
  /** Every way of asking, and a group no model has named yet. */
  quoted: boolean;
  asks: number;
  /** Of the Intent's placed asks, for groups and ways alike. */
  share: number;
}

/** What the All intents table needs per Intent: the rows its chevron opens. */
export interface IntentBreakdownSummary {
  topicId: string;
  asks: number;
  placed: number;
  /** "What they ask for" groups. */
  groups: number;
  /** Rows the expansion shows: the groups, or the one group's ways when that level is skipped. */
  children: number;
  skipped: boolean;
  /** The listed ones, most asks first; `children` counts the rest too. */
  rows: BreakdownRow[];
}

export const GROUPS_SHOWN = 20;
export const WAYS_SHOWN = 10;
export const ALSO_WANTS_SHOWN = 5;
const ELSEWHERE_SHOWN = 5;

interface Frame {
  group: string;
  cluster: string;
}

/** The ask's frames that reached a group, first frame per group, in order. */
function framesOf(ask: PlacedAsk, clusters: BreakdownInput["clusters"]): Frame[] {
  const out: Frame[] = [];
  for (const cluster of ask.clusters) {
    const group = clusters.get(cluster)?.parentId;
    if (!group || out.some((f) => f.group === group)) continue;
    out.push({ group, cluster });
  }
  return out;
}

const inc = <K>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
function nested<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = make()));
  return value;
}
const byCount =
  <T extends { asks: number }>(key: (t: T) => string) =>
  (a: T, b: T) =>
    b.asks - a.asks || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
/** What a group reads as: a model's name as written, else its busiest way of asking here, quoted. */
function groupLabel(
  meta: { label: string; named: boolean } | undefined,
  busiest: string | undefined,
): { label: string; quoted: boolean } {
  if (meta?.named) return { label: meta.label, quoted: false };
  return busiest ? { label: busiest, quoted: true } : { label: meta?.label ?? "", quoted: false };
}

/** Every Intent's breakdown. Samples are left empty for the loader to fill. */
export function buildBreakdowns(input: BreakdownInput): Map<string, IntentBreakdown> {
  const placedAsks = input.asks
    .map((ask) => ({ topicId: ask.topicId, frames: framesOf(ask, input.clusters) }))
    .filter((a) => a.frames.length > 0);

  // Where each group belongs: the Intent most of its asks' turns are in.
  const votes = new Map<string, Map<string, number>>();
  for (const ask of placedAsks)
    for (const f of ask.frames)
      inc(
        nested(votes, f.group, () => new Map<string, number>()),
        ask.topicId,
      );
  const size = (topicId: string) => input.asksByTopic.get(topicId) ?? 0;
  const home = new Map<string, string>();
  for (const [group, counts] of votes) {
    const [best] = [...counts].sort(
      (a, b) => b[1] - a[1] || size(b[0]) - size(a[0]) || (a[0] < b[0] ? -1 : 1),
    );
    home.set(group, best![0]);
  }

  // Each ask once, under its main frame; its other frames' Intents as "Also wants".
  const counted = new Map<string, Map<string, number>>(); // topic -> group -> asks
  const ways = new Map<string, Map<string, number>>(); // `${topic}\u0000${group}` -> cluster -> asks
  const alsoWants = new Map<string, Map<string, number>>(); // topic -> other topic -> asks
  const placed = new Map<string, number>();
  for (const ask of placedAsks) {
    const main = ask.frames.find((f) => home.get(f.group) === ask.topicId) ?? ask.frames[0]!;
    inc(placed, ask.topicId);
    inc(
      nested(counted, ask.topicId, () => new Map<string, number>()),
      main.group,
    );
    inc(
      nested(ways, `${ask.topicId}\u0000${main.group}`, () => new Map<string, number>()),
      main.cluster,
    );
    const wanted = new Set<string>();
    for (const f of ask.frames) {
      const other = home.get(f.group)!;
      if (f !== main && other !== ask.topicId && other !== home.get(main.group)) wanted.add(other);
    }
    for (const other of wanted)
      inc(
        nested(alsoWants, ask.topicId, () => new Map<string, number>()),
        other,
      );
  }

  const totals = new Map<string, number>();
  for (const groups of counted.values()) for (const [group, n] of groups) inc(totals, group, n);

  const out = new Map<string, IntentBreakdown>();
  const topics = new Set([...input.asksByTopic.keys(), ...placed.keys()]);
  for (const topicId of [...topics].sort()) {
    const here = counted.get(topicId) ?? new Map<string, number>();
    const placedHere = placed.get(topicId) ?? 0;
    const share = (n: number) => (placedHere === 0 ? 0 : n / placedHere);
    const groups: AskForGroup[] = [];
    const elsewhere: IntentBreakdown["elsewhere"]["groups"] = [];
    let elsewhereAsks = 0;
    for (const [group, n] of here) {
      const meta = input.groups.get(group);
      const busiestHere = [
        ...(ways.get(`${topicId}\u0000${group}`) ?? new Map<string, number>()),
      ].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      const { label, quoted } = groupLabel(
        meta,
        busiestHere ? input.clusters.get(busiestHere[0])?.label || undefined : undefined,
      );
      if (home.get(group) !== topicId) {
        elsewhereAsks += n;
        elsewhere.push({ id: group, label, topicId: home.get(group)!, asks: n });
        continue;
      }
      const alsoIn = [...counted]
        .filter(([other, g]) => other !== topicId && (g.get(group) ?? 0) > 0)
        .map(([other, g]) => ({ topicId: other, asks: g.get(group)! }))
        .sort(byCount((x) => x.topicId));
      const allWays = [...(ways.get(`${topicId}\u0000${group}`) ?? new Map<string, number>())]
        .map(
          ([cluster, asks]): WayOfAsking => ({
            id: cluster,
            label: input.clusters.get(cluster)?.label ?? "",
            asks,
            of: n,
            samples: [],
          }),
        )
        .sort(byCount((w) => w.id));
      groups.push({
        id: group,
        label,
        named: meta?.named ?? false,
        quoted,
        asks: n,
        share: share(n),
        totalAsks: totals.get(group) ?? n,
        alsoIn,
        waysOfAsking: {
          skipped: allWays.length === 1,
          ways: allWays.slice(0, WAYS_SHOWN),
          more: Math.max(0, allWays.length - WAYS_SHOWN),
        },
      });
    }
    groups.sort(byCount((g) => g.id));
    elsewhere.sort(byCount((g) => g.id));
    const wanted = [...(alsoWants.get(topicId) ?? new Map<string, number>())]
      .map(([other, asks]) => ({ topicId: other, asks, share: share(asks) }))
      .sort(byCount((w) => w.topicId));
    out.set(topicId, {
      topicId,
      asks: Math.max(size(topicId), placedHere),
      placed: placedHere,
      capped: input.capped.has(topicId),
      whatTheyAskFor: {
        skipped: groups.length === 1,
        groups: groups.slice(0, GROUPS_SHOWN),
        more: Math.max(0, groups.length - GROUPS_SHOWN),
      },
      elsewhere: { asks: elsewhereAsks, groups: elsewhere.slice(0, ELSEWHERE_SHOWN) },
      alsoWants: wanted.slice(0, ALSO_WANTS_SHOWN),
    });
  }
  return out;
}

/** The All intents table's view of each breakdown. */
export function summarizeBreakdown(b: IntentBreakdown): IntentBreakdownSummary {
  const groups = b.whatTheyAskFor.groups.length + b.whatTheyAskFor.more;
  const only = b.whatTheyAskFor.skipped ? b.whatTheyAskFor.groups[0] : undefined;
  const share = (asks: number) => (b.placed === 0 ? 0 : asks / b.placed);
  return {
    topicId: b.topicId,
    asks: b.asks,
    placed: b.placed,
    groups,
    children: only ? only.waysOfAsking.ways.length + only.waysOfAsking.more : groups,
    skipped: b.whatTheyAskFor.skipped,
    rows: only
      ? only.waysOfAsking.ways.map(
          (w): BreakdownRow => ({
            id: w.id,
            kind: "way",
            label: w.label,
            quoted: true,
            asks: w.asks,
            share: share(w.asks),
          }),
        )
      : b.whatTheyAskFor.groups.map(
          (g): BreakdownRow => ({
            id: g.id,
            kind: "group",
            label: g.label,
            quoted: g.quoted,
            asks: g.asks,
            share: g.share,
          }),
        ),
  };
}

/**
 * Sample asks for a way of asking: its cluster's most typical members, its own
 * label left out. Typical, not newest: an ask that only just reached the
 * cluster by a shared name or date is the least like the rest, so it is the
 * last to stand for it.
 */
export function samplesOf(members: readonly string[], label: string, max: number): string[] {
  return centralPhrases(
    members.filter((m) => m !== label),
    max,
  );
}
