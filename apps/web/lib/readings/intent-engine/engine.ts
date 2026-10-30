import { randomUUID } from "node:crypto";
import { MAX_ID_CHARS } from "@/lib/readings/intent-engine/bounds";
import { extractFrames, type Frame } from "@/lib/readings/intent-engine/frames";
import {
  buildClusterIndex,
  type ClusterIndex,
  DEFAULT_THRESHOLDS,
  type MatchableCluster,
  type MatchThresholds,
} from "@/lib/readings/intent-engine/match";
import { proposeParts, splitAsk } from "@/lib/readings/intent-engine/split";
import {
  actionHeads,
  cleanAskText,
  identifierWords,
  MEMBER_TEXT_MAX,
  stem,
  VerbLexicon,
} from "@/lib/readings/intent-engine/text";
import { turnKey } from "@/lib/readings/intent-graph/fold";
import type { FoldableHit } from "@/lib/readings/intent-graph/queries";
import type {
  AskKind,
  CapabilityEdges,
  EngineAssignment,
  EngineCluster,
  EngineState,
  SourceSlice,
} from "@/lib/readings/intent-types/engine-types";

/**
 * The intent engine's fold: place each ask of a page of events in a cluster,
 * and credit the capabilities its turn ran.
 *
 * It follows the adaptive-ranking learner (`lib/intent-graph/fold.ts`, the
 * SDK's `UsageLearner`) where a runtime would read the result (serving it is
 * deferred: ADR-0014 keeps the learner's graph): a search or an
 * OTLP prompt that the agent acted on is a confirmed observation (support + 1,
 * one edge count per call), and a search it did not act on only counts what it
 * showed (`surfaced_*`). Where Cloud alone reads the result it goes further:
 *
 *   - every ask is clustered, acted on or not, so the asks nothing answered
 *     (the skill-gap material) have clusters too. They carry no served edges
 *     and are never served to a runtime;
 *   - a user's message (`turn_start.user_message`) is an ask as well, credited
 *     with everything its turn ran, as matching evidence (`usage`) only;
 *   - an ask holding two requests is split when its parts confirm it, or
 *     counted toward each cluster it contains (`./match.ts`, `./split.ts`).
 *
 * Pure: state in, state out, plus the assignments to persist. Nothing here
 * reads the clock except through `now`, and nothing logs.
 */

/** The rows the engine reads: the fold's, plus `turn_start` (a user's message). */
export interface EngineEventRow {
  id: string;
  type: "search" | "skill_search" | "invoke_start" | "skill_invoke" | "turn_start";
  lane: "runtime" | "otlp";
  sessionId: string | null;
  turnId: string | null;
  sourceId: string | null;
  /** The ask text: search query, OTLP prompt, or user message. */
  query: string | null;
  toolId: string | null;
  skillId: string | null;
  receivedAt: Date;
  occurredAt?: Date | null;
  /** The OTLP trace, when the row came over OTLP. */
  traceId?: string | null;
  endUserId?: string | null;
}

export interface FoldAsksInput {
  state: EngineState;
  rows: readonly EngineEventRow[];
  hits: ReadonlyMap<string, readonly FoldableHit[]>;
  /** The project's tool and skill ids: vocabulary and verbs. */
  catalogIds?: readonly string[];
  /** The ask last learned per OTLP trace in an earlier fold, by turn key. */
  priorAsks?: ReadonlyMap<string, string>;
  thresholds?: MatchThresholds;
  /**
   * Read each ask as intent frames (`ENGINE_DEFAULTS.frames` in `./job.ts`): an ask with
   * several actions is placed once per action, each frame matched or created
   * on its own, and only ever the raw search is served.
   */
  frames?: boolean;
  now: number;
}

export interface FoldAsksStats {
  asks: number;
  joined: number;
  created: number;
  split: number;
  contained: number;
  repeated: number;
  confirmed: number;
  /** Asks holding several actions that joined a cluster without becoming its members. */
  multiAction: number;
}

export interface FoldAsksOutput {
  state: EngineState;
  assignments: EngineAssignment[];
  stats: FoldAsksStats;
}

/** Members kept per cluster (the SDK's `MEMBER_CAP`). Newest kept. */
export const MEMBER_CAP = 50;

interface Ask {
  row: EngineEventRow;
  kind: AskKind;
  text: string;
  at: number;
}

interface Invoke {
  cap: string;
  kind: "tool" | "skill";
  id: string;
  at: number;
}

export function foldAsks(input: FoldAsksInput): FoldAsksOutput {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const clusters = input.state.clusters.map(cloneCluster);
  let nextGraphN = input.state.nextGraphN;
  const byUuid = new Map(clusters.map((c) => [c.uuid, c]));
  const stats: FoldAsksStats = {
    asks: 0,
    joined: 0,
    created: 0,
    split: 0,
    contained: 0,
    repeated: 0,
    confirmed: 0,
    multiAction: 0,
  };
  const assignments: EngineAssignment[] = [];

  const verbs = new VerbLexicon();
  for (const id of input.catalogIds ?? []) verbs.learnTool(id);
  for (const row of input.rows) if (row.toolId) verbs.learnTool(row.toolId);

  const turns = groupTurns(input.rows, input.priorAsks, () => (stats.repeated += 1));
  const pageText = turns.flatMap((t) => t.asks.map((a) => a.text));
  const index = buildClusterIndex(
    clusters.map((c, i) => matchable(c, i)),
    [...pageText, ...(input.catalogIds ?? []).map((id) => id.replace(/[_\-.:/]+/g, " "))],
  );
  const ranks = new Map(clusters.map((c, i) => [c.uuid, i]));
  let nextRank = clusters.length;

  const create = (text: string, at: number): EngineCluster => {
    const member = text.slice(0, MEMBER_TEXT_MAX);
    const cluster: EngineCluster = {
      uuid: randomUUID(),
      id: `intent_${nextGraphN++}`,
      label: member,
      terms: [],
      members: [member],
      servedMembers: [],
      support: 0,
      asks: 0,
      first_ts: at,
      last_ts: at,
      tools: {},
      skills: {},
      usage: {},
      sources: {},
      queryIntentId: null,
      dirty: true,
    };
    clusters.push(cluster);
    byUuid.set(cluster.uuid, cluster);
    ranks.set(cluster.uuid, nextRank++);
    // In the index at once, seed member included, so the next frame of the same
    // ask finds it: `credit` only adds members that are new, so crediting the
    // seed again posts nothing twice.
    index.add(matchable(cluster, ranks.get(cluster.uuid)!));
    stats.created += 1;
    return cluster;
  };

  const credit = (
    cluster: EngineCluster,
    ask: Ask,
    askIndex: number,
    opts: {
      text: string;
      /** Added to the cluster's matching members; null keeps the cluster's wording as it is. */
      member: string | null;
      /** Added to what a runtime is served, when confirmed; the member unless given. */
      servedMember?: string | null;
      served: Invoke[] | null;
      usage: Invoke[];
      surfaced: string[];
    },
  ) => {
    cluster.dirty = true;
    cluster.asks += 1;
    cluster.last_ts = Math.max(cluster.last_ts ?? 0, ask.at);
    const newMembers: string[] = [];
    if (opts.member && pushMember(cluster.members, opts.member)) newMembers.push(opts.member);
    for (const inv of distinctCaps(opts.usage)) cluster.usage[inv] = (cluster.usage[inv] ?? 0) + 1;
    const source = ask.row.sourceId;
    // The learner's own observation: what a runtime is served.
    if (opts.served && opts.served.length > 0) {
      stats.confirmed += 1;
      const served = opts.servedMember === undefined ? opts.member : opts.servedMember;
      observe(cluster, cluster.servedMembers, served, opts.served, ask.at);
      if (source !== null) {
        const slice = sliceOf(cluster, source);
        observe(slice, slice.members, served, opts.served, ask.at);
      }
    }
    if (opts.surfaced.length > 0 && (cluster.support > 0 || (opts.served?.length ?? 0) > 0)) {
      surface(cluster, opts.surfaced);
      if (source !== null) surface(sliceOf(cluster, source), opts.surfaced);
    }
    assignments.push({
      eventId: ask.row.id,
      askIndex,
      clusterUuid: cluster.uuid,
      kind: ask.kind,
      text: opts.text,
      endUserId: ask.row.endUserId ?? null,
      sessionId: ask.row.sessionId,
      turnId: ask.row.turnId,
      traceId: ask.row.traceId ?? null,
      sourceId: source,
      at: ask.at,
    });
    index.add(matchable(cluster, ranks.get(cluster.uuid)!), newMembers);
  };

  const sliceOf = (cluster: EngineCluster, sourceId: string): SourceSlice => {
    let slice = cluster.sources[sourceId];
    if (!slice) {
      slice = { graphId: `intent_${nextGraphN++}`, support: 0, members: [], tools: {}, skills: {} };
      cluster.sources[sourceId] = slice;
    }
    return slice;
  };

  /**
   * An ask read as several frames: each frame joins the cluster it matches or
   * seeds its own, and frames landing in one cluster count there once. The
   * tools the ask led to are split between the frames as a split ask's are.
   *
   * What a runtime is served stays the learner's: the raw search, whole, once,
   * credited to one frame's cluster with every call it led to (the frame whose
   * cluster already leads to the first call, else the frame whose action names
   * it, else the first). The other frames learn usage only.
   */
  const placeFrames = (
    ask: TurnAsk,
    frames: readonly Frame[],
    own: Invoke[] | null,
    usage: Invoke[],
    surfaced: string[],
  ) => {
    const placed: Array<{ cluster: EngineCluster; frame: Frame }> = [];
    for (const frame of frames) {
      const result = index.match(frame.text, new Set(), thresholds);
      const cluster = result.kind === "join" ? byUuid.get(result.key)! : create(frame.text, ask.at);
      if (result.kind === "join") stats.joined += 1;
      if (!placed.some((p) => p.cluster === cluster)) placed.push({ cluster, frame });
    }
    const split = splitInvokes(
      placed.map((p) => p.cluster),
      usage,
    );
    const first = own?.[0];
    let servedAt = 0;
    if (first) {
      const leads = placed.findIndex(
        (p) => (first.kind === "tool" ? p.cluster.tools : p.cluster.skills)[first.id] !== undefined,
      );
      const words = new Set(identifierWords(first.id).map(stem));
      const names = placed.findIndex((p) => p.frame.action !== null && words.has(p.frame.action));
      servedAt = leads >= 0 ? leads : names >= 0 ? names : 0;
    }
    placed.forEach(({ cluster, frame }, i) => {
      const served = own !== null && i === servedAt;
      credit(cluster, ask, i, {
        text: frame.text,
        // A synthetic frame is matched on, never stored; a cluster it seeded already holds it.
        member:
          frame.synthetic && cluster.members.length > 0
            ? null
            : frame.text.slice(0, MEMBER_TEXT_MAX),
        servedMember: served ? ask.text.slice(0, MEMBER_TEXT_MAX) : null,
        served: served ? own : null,
        usage: split[i],
        surfaced: served ? surfaced : [],
      });
    });
  };

  for (const turn of turns) {
    const witness = new Set(turn.invokes.map((i) => i.cap));
    for (const ask of turn.asks) {
      stats.asks += 1;
      // A search or prompt is confirmed by the calls between it and the turn's next one; a user's
      // message is credited with the whole turn, as evidence only.
      const own = ask.kind === "user_message" ? null : ask.confirmedBy;
      const usage = ask.kind === "user_message" ? turn.invokes : (ask.confirmedBy ?? []);
      const surfaced = surfacedBy(ask, own ?? [], input.hits.get(ask.row.id));

      const frames = input.frames ? extractFrames(ask.text, verbs) : null;
      if (frames && frames.length >= 2) {
        stats.split += 1;
        placeFrames(ask, frames, own, usage, surfaced);
        continue;
      }

      const parts = frames ? null : splitAsk(ask.text, verbs, index, witness, thresholds);
      if (parts) {
        stats.split += 1;
        const split = splitInvokes(
          parts.map((p) => byUuid.get(p.key)!),
          usage,
        );
        parts.forEach((part, i) => {
          const cluster = byUuid.get(part.key)!;
          credit(cluster, ask, i, {
            text: part.text,
            member: part.synthetic ? null : part.text.slice(0, MEMBER_TEXT_MAX),
            served: own ? split[i] : null,
            usage: split[i],
            surfaced: [],
          });
        });
        continue;
      }

      const result = index.match(ask.text, witness, thresholds);
      // An ask that reads as several requests and joins nothing counts toward
      // each cluster whose wording it wholly holds, without becoming a member.
      const holds =
        !frames && result.kind === "new" && proposeParts(ask.text, verbs).length > 1
          ? index.containedIn(ask.text, thresholds.strong)
          : [];
      if (holds.length >= 2) {
        stats.contained += 1;
        const holders = holds.map((k) => byUuid.get(k)!);
        const split = splitInvokes(holders, usage);
        holders.forEach((cluster, i) =>
          credit(cluster, ask, i, {
            text: ask.text,
            member: null,
            served: null,
            usage: split[i],
            surfaced: [],
          }),
        );
        continue;
      }
      const cluster = result.kind === "join" ? byUuid.get(result.key)! : create(ask.text, ask.at);
      if (result.kind === "join") stats.joined += 1;
      const member = ask.text.slice(0, MEMBER_TEXT_MAX);
      // An ask holding several actions that joined a cluster whole counts there,
      // and a runtime is still served it as the search it was, but it never widens
      // the cluster's wording: as a member it would bridge the cluster to every
      // other action it names. It stays a member only of a cluster it seeds.
      // Read as frames, an ask with one frame holds one action whatever its verbs.
      const bridges = !frames && result.kind === "join" && actionHeads(ask.text, verbs) >= 2;
      if (bridges) stats.multiAction += 1;
      credit(cluster, ask, 0, {
        text: ask.text,
        member: bridges ? null : member,
        servedMember: member,
        served: own,
        usage,
        surfaced,
      });
    }
  }

  return { state: { clusters, nextGraphN }, assignments, stats };
}

/* turns */

interface TurnAsk extends Ask {
  /** The calls between this ask and the turn's next search or prompt; null for a user's message. */
  confirmedBy: Invoke[] | null;
}

interface PageTurn {
  key: string;
  asks: TurnAsk[];
  invokes: Invoke[];
}

/** The page's turns, in the order each first appeared, steps in order within. */
function groupTurns(
  rows: readonly EngineEventRow[],
  priorAsks: ReadonlyMap<string, string> | undefined,
  onRepeat: () => void,
): PageTurn[] {
  const turns = new Map<string, PageTurn>();
  const lastAsk = new Map<string, string>(priorAsks ?? []);
  // The search or prompt the next call confirms, per turn.
  const open = new Map<string, TurnAsk>();
  for (const row of rows) {
    const key = turnKey(row);
    let turn = turns.get(key);
    if (!turn) turns.set(key, (turn = { key, asks: [], invokes: [] }));
    const at = (row.occurredAt ?? row.receivedAt).getTime();
    if (row.type === "invoke_start" || row.type === "skill_invoke") {
      const id = row.type === "invoke_start" ? row.toolId : row.skillId;
      // An id past any real one's length is not credited: the maps it would key are bounded.
      if (!id || id.length > MAX_ID_CHARS) continue;
      const kind = row.type === "invoke_start" ? "tool" : "skill";
      const invoke: Invoke = { cap: `${kind}:${id}`, kind, id, at };
      turn.invokes.push(invoke);
      open.get(key)?.confirmedBy?.push(invoke);
      continue;
    }
    if (!row.query) continue;
    const text = cleanAskText(row.query);
    if (!text) continue;
    const kind: AskKind =
      row.type === "turn_start" ? "user_message" : row.lane === "otlp" ? "prompt" : "search";
    // An agent loop re-sends the user's message on every model call: learn a trace's ask once per change.
    if (kind === "prompt") {
      if (lastAsk.get(key) === row.query) {
        onRepeat();
        continue;
      }
      lastAsk.set(key, row.query);
    }
    const ask: TurnAsk = { row, kind, text, at, confirmedBy: kind === "user_message" ? null : [] };
    turn.asks.push(ask);
    if (kind !== "user_message") open.set(key, ask);
  }
  return [...turns.values()].filter((t) => t.asks.length > 0);
}

/** Give each of several clusters the calls it already leads to; the rest by order. */
function splitInvokes(clusters: readonly EngineCluster[], invokes: readonly Invoke[]): Invoke[][] {
  const out: Invoke[][] = clusters.map(() => []);
  invokes.forEach((inv, position) => {
    let best = -1;
    let bestCount = 0;
    clusters.forEach((c, i) => {
      const count = c.usage[inv.cap] ?? 0;
      if (count > bestCount) {
        best = i;
        bestCount = count;
      }
    });
    if (best < 0)
      best = Math.min(
        clusters.length - 1,
        Math.floor((position * clusters.length) / Math.max(1, invokes.length)),
      );
    out[best].push(inv);
  });
  return out;
}

/* credit */

function observe(
  target: CapabilityEdges & { support: number; last_ts?: number },
  members: string[],
  member: string | null,
  calls: readonly Invoke[],
  at: number,
) {
  target.support += 1;
  target.last_ts = Math.max(target.last_ts ?? 0, at);
  for (const call of calls) {
    const map = call.kind === "tool" ? target.tools : target.skills;
    map[call.id] = (map[call.id] ?? 0) + 1;
  }
  // A rewritten part ("fix the failed CI tests") is credited but never stored as a member.
  if (member) pushMember(members, member);
}

/** Capabilities a search showed at or above the one picked without being picked; all it showed when nothing was picked. */
function surfacedBy(
  ask: Ask,
  picked: readonly Invoke[],
  hits: readonly FoldableHit[] | undefined,
): string[] {
  if (ask.kind !== "search" || !hits || hits.length === 0) return [];
  const ordered = [...hits].sort((a, b) => a.rank - b.rank);
  const pickedIds = new Set(picked.map((p) => `${p.kind}:${p.id}`));
  const pickRank = ordered.findIndex((h) => pickedIds.has(`${h.targetType}:${h.targetId}`));
  const shown = pickRank < 0 ? ordered : ordered.slice(0, pickRank);
  return shown
    .filter(
      (h) =>
        (h.targetType === "tool" || h.targetType === "skill") &&
        !pickedIds.has(`${h.targetType}:${h.targetId}`),
    )
    .map((h) => `${h.targetType}:${h.targetId}`);
}

function surface(target: CapabilityEdges, caps: readonly string[]) {
  for (const cap of caps) {
    const [kind, ...rest] = cap.split(":");
    const id = rest.join(":");
    const key = kind === "tool" ? "surfaced_tools" : "surfaced_skills";
    const map = (target[key] ??= {});
    map[id] = (map[id] ?? 0) + 1;
  }
}

function distinctCaps(invokes: readonly Invoke[]): string[] {
  return [...new Set(invokes.map((i) => i.cap))];
}

/** Add a member if new; keep the newest {@link MEMBER_CAP}. Returns whether it was added. */
function pushMember(members: string[], text: string): boolean {
  if (members.includes(text)) return false;
  members.push(text);
  if (members.length > MEMBER_CAP) members.splice(0, members.length - MEMBER_CAP);
  return true;
}

function matchable(cluster: EngineCluster, rank: number): MatchableCluster {
  return { key: cluster.uuid, members: cluster.members, usage: cluster.usage, rank };
}

function cloneCluster(c: EngineCluster): EngineCluster {
  return structuredClone({ ...c, dirty: false });
}

/** Rebuild an index over clusters as they stand, for read-only matching (compaction, seeding). */
export function indexClusters(
  clusters: readonly EngineCluster[],
  extraText: readonly string[] = [],
): ClusterIndex {
  return buildClusterIndex(
    clusters.map((c, i) => matchable(c, i)),
    extraText,
  );
}
