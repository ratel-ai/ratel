import { IntentGraph, ToolCatalog, type ToolRegistry } from "@ratel-ai/sdk";
import type { FoldableEventRow, FoldableHit, FoldLane } from "@/lib/readings/intent-graph/queries";

/**
 * Fold stored runtime events into an intent graph with the open-source SDK's own
 * learner (ADR-0014). Cloud never reimplements clustering: a scratch catalog
 * with no tools hosts the learner, and each event goes through `recordEvent`
 * in the order it was received, exactly as it would have inside the runtime.
 *
 * Pairing is keyed by `(session_id, turn_id)`. The core keys its pending slot
 * and the graph's credit slot by turn key alone, so the session id is folded
 * into the key; without it two sessions searching concurrently would credit
 * each other's invokes. This mirrors what the native replay path does.
 *
 * Two lanes feed it, already mapped to one shape by the reader. The runtime
 * lane is the SDK's own pair: a tool search with its query, then the invoke.
 * The OTLP lane is a plain agent trace: the user's ask (the trace's model call,
 * when the exporter captures content) as a `baseline` search with no served
 * list, then each tool-call span as an invoke. The trace is the turn: the
 * reader keys both rows by the trace id alone, since a tool span exported on
 * its own resolves no conversation id. A trace's spans land in whatever order
 * the exporter's batches do, so its rows are put back in the order they
 * happened before the learner sees them, and an ask that merely repeats the
 * trace's last one (an agent loop re-sends the user's message on every model
 * call) is not learned again. This is how a customer gets a graph before
 * installing the SDK.
 *
 * Known properties, deliberately accepted:
 * - Observations are stamped with the fold's wall-clock time, not the event's
 *   `ts` (the live `recordEvent` path has no timestamp override). `last_ts` and
 *   `built_from_ts` therefore say when Cloud folded, not when the user asked.
 *   Recency grace is 90 days and the seed window is 30, so ranking is unaffected.
 * - The learner holds at most 256 open turns (PENDING_CAP, FIFO). More open
 *   search-without-invoke turns inside one page evict the oldest.
 * - Cloud has no embedder compatible with runtimes, so clusters form on the
 *   lexical tier only: no centroids, no `model`. A runtime can re-embed.
 *
 * Privacy: this module never logs. The JSON it returns carries raw user
 * queries (cluster members) and must be treated like trace events.
 */

export interface FoldInput {
  rows: readonly FoldableEventRow[];
  hits: ReadonlyMap<string, readonly FoldableHit[]>;
  /** The current stored graph document as JSON, or null to start empty. */
  baseJson: string | null;
  /** When given, each search is also ranked with and without the graph as it stood before it. */
  shadow?: FoldShadow;
  /**
   * Which graph this fold builds and which graph each runtime source ranks
   * from (its last `usage_ranking_status`). A search whose runtime ranks from
   * this very graph and sent `base_hits` is taken as the runtime's own report
   * instead of being replayed.
   */
  reports?: { graphKey: string; graphBySource: ReadonlyMap<string, string> };
  /**
   * The ask last learned from each OTLP trace in an earlier fold, by turn key,
   * so a trace folded in two passes does not learn its repeat again.
   */
  priorAsks?: ReadonlyMap<string, string>;
}

/**
 * Two registries holding the project's tool catalog. `plain` never has a
 * graph. `boosted` gets the graph being built attached read-only for the
 * length of the fold: the SDK shares one graph handle between catalogs, so it
 * sees every turn the learner has absorbed so far and nothing later.
 */
export interface FoldShadow {
  plain: ToolRegistry;
  boosted: ToolRegistry;
  /** How many results to keep per list. */
  k?: number;
}

/** One search ranked both ways, with the tool the agent then ran once its invoke is folded. */
export interface ShadowTurn {
  searchEventId: string;
  sourceId: string | null;
  occurredAt: Date;
  plainIds: string[];
  boostedIds: string[];
  /** Whether a cluster matched the query and the boost was armed. */
  matched: boolean;
  /** Whether the two lists came from the runtime (`hits` and `base_hits`) rather than Cloud's replay. */
  reported: boolean;
  invokedToolId: string | null;
}

export interface FoldOutput {
  json: string;
  rev: number;
  clusterCount: number;
  /** Events handed to the learner. */
  recorded: number;
  /** Of those, how many came from each ingest lane. */
  recordedByLane: Record<FoldLane, number>;
  /** Events dropped for a missing required field. */
  skipped: number;
  /** OTLP asks not learned because they repeat the trace's previous ask. */
  repeated: number;
  /** Empty unless `shadow` was given. */
  shadowTurns: ShadowTurn[];
}

export const SHADOW_TOP_K = 5;

const KNOWN_ORIGINS = new Set(["direct", "agent", "baseline"]);

/** The origin Cloud's own shadow searches carry; they are never recorded anywhere. */
const SHADOW_ORIGIN = "agent";

/**
 * How long a search with no invoke yet may hold the fold back. A turn's search
 * and invoke can arrive in two ingest batches a moment apart, and the
 * learner's pending search does not survive between fold runs, so folding the
 * search alone loses the turn. Long enough for the next batch to land, short
 * enough that a search the agent never acted on delays learning by a minute.
 */
export const FOLD_HOLD_GRACE_MS = 60_000;

/**
 * How long an OTLP trace may hold the fold back in all, counted from its
 * first row. A trace has no closing row: it is complete when it goes quiet
 * for the grace. A chat loop that keeps one trace open for hours would
 * otherwise hold the page as long; past this it is folded as far as it got.
 */
export const FOLD_HOLD_MAX_MS = 10 * 60_000;

/* — the fold ——————————————————————————————————————————————————————————————— */

export function foldEventsIntoGraph(input: FoldInput): FoldOutput {
  const graph = input.baseJson ? IntentGraph.fromJson(input.baseJson) : new IntentGraph();
  // A noop sink: the learner wraps whatever base sink is configured, and a
  // memory sink would retain every envelope (query text included) for nothing.
  const catalog = new ToolCatalog({ trace: { kind: "noop" } });
  catalog.experimentalEnableAdaptiveRanking(graph, {
    learn: true,
    provenance: "seeded",
    origins: "any",
    warnOnModelMismatch: false,
  });
  const shadow = input.shadow;
  const k = shadow?.k ?? SHADOW_TOP_K;
  // Read-only on the same graph object: a learn:false lexical search takes a
  // read lock only, records no impression and emits into its own noop sink, so
  // the graph being built is byte-for-byte what it would be without it.
  shadow?.boosted.experimentalEnableAdaptiveRanking(graph, {
    learn: false,
    warnOnModelMismatch: false,
  });

  const shadowTurns: ShadowTurn[] = [];
  const openByTurn = new Map<string, ShadowTurn>();
  // The last ask learned per OTLP trace: an agent loop sends the same user
  // message on every model call, and only a new ask opens a new turn. Seeded
  // with what earlier folds learned from traces that continue in this page.
  const lastAsk = new Map<string, string>(input.priorAsks ?? []);
  let recorded = 0;
  let skipped = 0;
  let repeated = 0;
  const recordedByLane: Record<FoldLane, number> = { runtime: 0, otlp: 0 };
  try {
    for (const row of learningOrder(input.rows)) {
      const event = toCoreEvent(row, input.hits.get(row.id));
      if (!event) {
        skipped += 1;
        continue;
      }
      if (row.lane === "otlp" && row.type === "search" && row.query) {
        const key = turnKey(row);
        if (lastAsk.get(key) === row.query) {
          repeated += 1;
          continue;
        }
        lastAsk.set(key, row.query);
      }
      if (shadow && row.type === "search" && row.query) {
        const reported = reportedLists(row, input.hits.get(row.id), input.reports, k);
        let lists: Pick<ShadowTurn, "plainIds" | "boostedIds" | "matched" | "reported">;
        if (reported) {
          lists = { ...reported, matched: true, reported: true };
        } else {
          // Before the learner sees this search: the boosted list reflects only earlier turns.
          const plain = shadow.plain.searchWithOrigin(row.query, k, SHADOW_ORIGIN);
          const boosted = shadow.boosted.searchWithOrigin(row.query, k, SHADOW_ORIGIN);
          lists = {
            plainIds: plain.map((hit) => hit.toolId),
            boostedIds: boosted.map((hit) => hit.toolId),
            matched: boosted[0]?.fused === true,
            reported: false,
          };
        }
        const turn: ShadowTurn = {
          searchEventId: row.id,
          sourceId: row.sourceId,
          occurredAt: row.occurredAt ?? row.receivedAt,
          ...lists,
          invokedToolId: null,
        };
        shadowTurns.push(turn);
        openByTurn.set(turnKey(row), turn);
      } else if (shadow && row.type === "invoke_start" && row.toolId) {
        // The first invoke after the turn's latest search is the one the agent chose.
        const turn = openByTurn.get(turnKey(row));
        if (turn && turn.invokedToolId === null) turn.invokedToolId = row.toolId;
      }
      catalog.recordEvent(event, { eventId: row.id, turnId: turnKey(row) });
      recorded += 1;
      recordedByLane[row.lane] += 1;
    }
  } finally {
    shadow?.boosted.experimentalDisableAdaptiveRanking();
    catalog.experimentalDisableAdaptiveRanking();
  }

  return {
    json: graph.toJson(),
    rev: graph.rev,
    clusterCount: graph.clusterCount,
    recorded,
    recordedByLane,
    skipped,
    repeated,
    shadowTurns,
  };
}

/* — helpers ———————————————————————————————————————————————————————————————— */

/**
 * The runtime's own two rankings for a search, when it sent them and it ranks
 * from the graph being folded: `base_hits` is what it would have served
 * without the graph, the stored hits what it did serve. Null means replay.
 */
function reportedLists(
  row: FoldableEventRow,
  hits: readonly FoldableHit[] | undefined,
  reports: FoldInput["reports"],
  k: number,
): { plainIds: string[]; boostedIds: string[] } | null {
  if (!reports || !row.baseHitIds || row.baseHitIds.length === 0 || row.sourceId === null)
    return null;
  if (reports.graphBySource.get(row.sourceId) !== reports.graphKey) return null;
  const served = (hits ?? [])
    .filter((hit) => hit.targetType === "tool")
    .sort((a, b) => a.rank - b.rank)
    .map((hit) => hit.targetId);
  if (served.length === 0) return null;
  return { plainIds: row.baseHitIds.slice(0, k), boostedIds: served.slice(0, k) };
}

/** The wire shape the core's `TraceEvent` serde accepts for the four learning
 * events. Anything the row lacks is filled with a neutral value; the learner
 * reads only query, origin, hit ids and the invoked id. */
export function toCoreEvent(
  row: FoldableEventRow,
  hits: readonly FoldableHit[] | undefined,
): Record<string, unknown> | null {
  switch (row.type) {
    case "search": {
      if (!row.query) return null;
      const ranked = (hits ?? [])
        .filter((h) => h.targetType === "tool")
        .map((h) => ({ tool_id: h.targetId, score: h.score ?? 0 }));
      return {
        type: "search",
        query: row.query,
        origin: normalizeOrigin(row.origin),
        top_k: row.topK ?? ranked.length,
        hits: ranked,
        stages: [],
        took_ms: row.tookMs ?? 0,
      };
    }
    case "skill_search": {
      if (!row.query) return null;
      const ranked = (hits ?? [])
        .filter((h) => h.targetType === "skill")
        .map((h) => ({ skill_id: h.targetId, score: h.score ?? 0 }));
      return {
        type: "skill_search",
        query: row.query,
        origin: normalizeOrigin(row.origin),
        top_k: row.topK ?? ranked.length,
        hits: ranked,
        stages: [],
        took_ms: row.tookMs ?? 0,
      };
    }
    case "invoke_start":
      if (!row.toolId) return null;
      return { type: "invoke_start", tool_id: row.toolId, args_size_bytes: 0 };
    case "skill_invoke":
      if (!row.skillId) return null;
      return { type: "skill_invoke", skill_id: row.skillId, took_ms: row.tookMs ?? 0 };
    default:
      return null;
  }
}

function normalizeOrigin(origin: string | null): string {
  return origin && KNOWN_ORIGINS.has(origin) ? origin : "direct";
}

/** The learner's pairing key for one event: session first, turn second. */
export function turnKey(row: Pick<FoldableEventRow, "sessionId" | "turnId">): string {
  return `${row.sessionId ?? ""}:${row.turnId ?? ""}`;
}

/**
 * The prefix of a page that is safe to fold now.
 *
 * Walk the rows in order: a search opens its turn, an invoke closes it. If a
 * turn is still open at the end of the page and its search is younger than the
 * grace, cut the page at that search's ingest batch (rows of one batch share
 * `receivedAtRaw`, so the cut never splits a batch) and leave the rest for the
 * next run, when the invoke has arrived. An open search older than the grace
 * is folded as it is: the agent did not act on it. A session that sends no
 * turn ids keys every event alike, so its trailing search holds for at most
 * the grace and never stalls.
 *
 * An OTLP trace has no closing row: its tool spans follow the ask across as
 * many export batches as the exporter makes, in either order. Every row of
 * the trace keeps it open, and the trace is complete once its newest row is
 * older than the grace; the cut is at the batch its first row came in, so the
 * whole trace folds in one run. `FOLD_HOLD_MAX_MS` after that first row the
 * trace folds whatever it has.
 */
export function foldablePrefix<
  Row extends Pick<
    FoldableEventRow,
    "type" | "lane" | "sessionId" | "turnId" | "receivedAt" | "receivedAtRaw"
  >,
>(
  rows: readonly Row[],
  nowMs: number,
  graceMs: number = FOLD_HOLD_GRACE_MS,
): { fold: Row[]; held: number } {
  // Per open turn: the row the cut lands on and the time the turn was last seen.
  const open = new Map<string, { cut: Row; seenAt: number }>();
  for (const row of rows) {
    const key = turnKey(row);
    if (row.lane === "otlp") {
      const trace = open.get(key);
      if (trace) trace.seenAt = row.receivedAt.getTime();
      else open.set(key, { cut: row, seenAt: row.receivedAt.getTime() });
    } else if (row.type === "search" || row.type === "skill_search") {
      if (!open.has(key)) open.set(key, { cut: row, seenAt: row.receivedAt.getTime() });
    } else {
      open.delete(key);
    }
  }
  let cutAt: string | null = null;
  let cutTime = Number.POSITIVE_INFINITY;
  for (const { cut, seenAt } of open.values()) {
    const received = cut.receivedAt.getTime();
    if (nowMs - seenAt >= graceMs || nowMs - received >= FOLD_HOLD_MAX_MS) continue;
    if (received < cutTime) {
      cutTime = received;
      cutAt = cut.receivedAtRaw;
    }
  }
  if (cutAt === null) return { fold: [...rows], held: 0 };
  const index = rows.findIndex((row) => row.receivedAtRaw === cutAt);
  return { fold: rows.slice(0, index), held: rows.length - index };
}

/**
 * The page in the order the learner should see it. Runtime rows stay where
 * the reader put them (ingest order, which is the SDK's emission order). OTLP
 * rows are reordered among themselves by the time they happened, the ask
 * before the tool calls of the same instant: a trace's tool spans can be
 * exported before its model call, and an invoke the learner sees before its
 * search pairs with nothing.
 */
export function learningOrder<
  Row extends Pick<FoldableEventRow, "type" | "lane" | "receivedAt" | "occurredAt">,
>(rows: readonly Row[]): Row[] {
  const slots: number[] = [];
  const otlp: Array<{ row: Row; index: number }> = [];
  rows.forEach((row, index) => {
    if (row.lane !== "otlp") return;
    slots.push(index);
    otlp.push({ row, index });
  });
  if (otlp.length < 2) return [...rows];
  const at = (row: Row) => (row.occurredAt ?? row.receivedAt).getTime();
  const rank = (row: Row) => (row.type === "search" || row.type === "skill_search" ? 0 : 1);
  otlp.sort((a, b) => at(a.row) - at(b.row) || rank(a.row) - rank(b.row) || a.index - b.index);
  const out = [...rows];
  slots.forEach((slot, i) => {
    out[slot] = otlp[i].row;
  });
  return out;
}
