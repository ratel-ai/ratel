import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "@ratel-ai/sdk";
import {
  type FoldShadow,
  foldablePrefix,
  foldEventsIntoGraph,
  toCoreEvent,
  turnKey,
} from "@/lib/readings/intent-graph/fold";
import type { FoldableEventRow, FoldableHit } from "@/lib/readings/intent-graph/queries";

/**
 * Pure fold over in-memory rows against the real @ratel-ai/sdk learner. No DB.
 * Each test proves one property of the pairing or the wire mapping; the
 * learner's own clustering is the SDK's contract, not re-asserted here.
 */

let seq = 0;
function row(over: Partial<FoldableEventRow> & Pick<FoldableEventRow, "type">): FoldableEventRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    lane: "runtime",
    sessionId: "sess-a",
    sourceId: "acme-app",
    query: null,
    origin: "agent",
    toolId: null,
    skillId: null,
    topK: null,
    tookMs: null,
    receivedAt: new Date(1_790_000_000_000 + seq),
    receivedAtRaw: new Date(1_790_000_000_000 + seq).toISOString(),
    turnId: null,
    ...over,
  };
}

function hitsFor(
  rows: readonly FoldableEventRow[],
  ids: readonly string[],
): Map<string, FoldableHit[]> {
  const map = new Map<string, FoldableHit[]>();
  for (const r of rows) {
    if (r.type !== "search" && r.type !== "skill_search") continue;
    map.set(
      r.id,
      ids.map((id, rank) => ({
        rank,
        targetType: r.type === "search" ? "tool" : "skill",
        targetId: id,
        score: 1 - rank * 0.1,
      })),
    );
  }
  return map;
}

function parse(json: string): {
  rev: number;
  intents: Array<{
    id: string;
    members: string[];
    support: number;
    seeded_support?: number;
    tools: Record<string, number>;
    skills: Record<string, number>;
    surfaced_tools?: Record<string, number>;
  }>;
} {
  return JSON.parse(json);
}

test("a search followed by an invoke in one session becomes one seeded cluster with a tool edge", () => {
  const rows = [
    row({ type: "search", query: "why is the build broken", turnId: "t1" }),
    row({ type: "invoke_start", toolId: "gh_run_list", turnId: "t1" }),
  ];
  const out = foldEventsIntoGraph({
    rows,
    hits: hitsFor(rows, ["docker_build", "gh_run_list"]),
    baseJson: null,
  });

  assert.equal(out.recorded, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.clusterCount, 1);
  const doc = parse(out.json);
  const [intent] = doc.intents;
  assert.ok(intent);
  assert.deepEqual(intent.members, ["why is the build broken"]);
  assert.equal(intent.support, 1);
  assert.equal(intent.seeded_support, 1, "cloud folds are seeded provenance");
  assert.equal(intent.tools.gh_run_list, 1);
  // docker_build ranked above the pick, so it is passed over once.
  assert.equal(intent.surfaced_tools?.docker_build, 1);
  assert.ok(out.rev >= 1);
});

test("two interleaved sessions without a turn id never credit each other's invokes", () => {
  const rows = [
    row({ type: "search", query: "why is the build broken", sessionId: "sess-a" }),
    row({ type: "search", query: "send the weekly report email", sessionId: "sess-b" }),
    row({ type: "invoke_start", toolId: "gh_run_list", sessionId: "sess-a" }),
    row({ type: "invoke_start", toolId: "send_email", sessionId: "sess-b" }),
  ];
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });

  const doc = parse(out.json);
  assert.equal(doc.intents.length, 2);
  const byMember = new Map(doc.intents.map((i) => [i.members[0], i]));
  assert.deepEqual(Object.keys(byMember.get("why is the build broken")?.tools ?? {}), [
    "gh_run_list",
  ]);
  assert.deepEqual(Object.keys(byMember.get("send the weekly report email")?.tools ?? {}), [
    "send_email",
  ]);
});

test("a skill search followed by a skill invoke fills the skills edge map", () => {
  const rows = [
    row({ type: "skill_search", query: "triage a failing ci run", turnId: "t1" }),
    row({ type: "skill_invoke", skillId: "ci-triage", turnId: "t1" }),
  ];
  const out = foldEventsIntoGraph({ rows, hits: hitsFor(rows, ["ci-triage"]), baseJson: null });

  const [intent] = parse(out.json).intents;
  assert.equal(intent?.skills["ci-triage"], 1);
  assert.deepEqual(intent?.tools, {});
});

test("an invoke with no prior search in its turn is ignored, not an error", () => {
  const rows = [row({ type: "invoke_start", toolId: "gh_run_list", turnId: "orphan" })];
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });
  assert.equal(out.recorded, 1);
  assert.equal(out.clusterCount, 0);
});

test("rows missing the field the learner needs are skipped and counted", () => {
  const rows = [
    row({ type: "search", query: null }),
    row({ type: "invoke_start", toolId: null }),
    row({ type: "skill_invoke", skillId: null }),
  ];
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });
  assert.equal(out.recorded, 0);
  assert.equal(out.skipped, 3);
});

test("an origin the core does not know is mapped to direct instead of throwing", () => {
  const rows = [
    row({ type: "search", query: "why is the build broken", origin: "mystery", turnId: "t1" }),
    row({ type: "invoke_start", toolId: "gh_run_list", turnId: "t1" }),
  ];
  assert.equal(toCoreEvent(rows[0]!, undefined)?.origin, "direct");
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });
  assert.equal(out.clusterCount, 1);
});

test("folding onto a base document keeps its clusters and moves the rev forward", () => {
  const first = foldEventsIntoGraph({
    rows: [
      row({ type: "search", query: "why is the build broken", turnId: "t1" }),
      row({ type: "invoke_start", toolId: "gh_run_list", turnId: "t1" }),
    ],
    hits: new Map(),
    baseJson: null,
  });
  const second = foldEventsIntoGraph({
    rows: [
      row({ type: "search", query: "send the weekly report email", turnId: "t2" }),
      row({ type: "invoke_start", toolId: "send_email", turnId: "t2" }),
    ],
    hits: new Map(),
    baseJson: first.json,
  });

  const doc = parse(second.json);
  assert.equal(doc.intents.length, 2);
  assert.ok(doc.intents.some((i) => i.members[0] === "why is the build broken"));
  assert.ok(second.rev > first.rev);
});

test("the pairing key is session first, turn second, with empty parts when absent", () => {
  assert.equal(turnKey({ sessionId: "s", turnId: "t" }), "s:t");
  assert.equal(turnKey({ sessionId: "s", turnId: null }), "s:");
  assert.equal(turnKey({ sessionId: null, turnId: null }), ":");
});

test("the wire mapping carries hits for search and skill_search and nothing else", () => {
  const search = row({ type: "search", query: "q", topK: 3, tookMs: 7 });
  const mapped = toCoreEvent(search, [
    { rank: 0, targetType: "tool", targetId: "a", score: 0.5 },
    { rank: 1, targetType: "skill", targetId: "s", score: 0.4 },
  ]);
  assert.deepEqual(mapped, {
    type: "search",
    query: "q",
    origin: "agent",
    top_k: 3,
    hits: [{ tool_id: "a", score: 0.5 }],
    stages: [],
    took_ms: 7,
  });
  assert.deepEqual(toCoreEvent(row({ type: "invoke_start", toolId: "a" }), undefined), {
    type: "invoke_start",
    tool_id: "a",
    args_size_bytes: 0,
  });
});

test("foldablePrefix holds a search whose invoke has not arrived, cut at its ingest batch, until the grace passes", () => {
  const now = Date.parse("2026-09-30T10:00:00Z");
  const row = (
    type: string,
    turnId: string | null,
    batch: number,
    ageMs: number,
    lane: "runtime" | "otlp" = "runtime",
  ) => ({
    type: type as "search",
    lane,
    sessionId: "s",
    turnId,
    receivedAt: new Date(now - ageMs),
    receivedAtRaw: `batch-${batch}`,
  });
  // Batch 1 holds a whole turn; batch 2 holds a whole turn and a search whose invoke is still to come.
  const rows = [
    row("search", "t1", 1, 5_000),
    row("invoke_start", "t1", 1, 5_000),
    row("search", "t2", 2, 2_000),
    row("invoke_start", "t2", 2, 2_000),
    row("search", "t3", 2, 2_000),
  ];
  const held = foldablePrefix(rows, now);
  assert.equal(held.fold.length, 2, "the whole second batch waits, so a batch is never split");
  assert.equal(held.held, 3);

  // Once the invoke is in the page, everything folds.
  assert.equal(foldablePrefix([...rows, row("invoke_start", "t3", 3, 500)], now).fold.length, 6);

  // A search older than the grace is folded as it is: the agent never acted on it.
  assert.equal(foldablePrefix(rows, now + 120_000).held, 0);

  // No turn ids: the session's trailing search holds, a closed one does not.
  const bare = [
    row("search", null, 1, 3_000),
    row("invoke_start", null, 1, 3_000),
    row("search", null, 2, 1_000),
  ];
  assert.equal(foldablePrefix(bare, now).fold.length, 2);
  assert.equal(foldablePrefix(bare.slice(0, 2), now).held, 0);
});

test("foldablePrefix holds an OTLP trace while it is still being exported, from its first row", () => {
  const now = Date.parse("2026-09-30T10:00:00Z");
  const row = (type: string, turnId: string, batch: number, ageMs: number) => ({
    type: type as "search",
    lane: "otlp" as const,
    sessionId: turnId,
    turnId,
    receivedAt: new Date(now - ageMs),
    receivedAtRaw: `batch-${batch}`,
  });
  // The tool span came in its own batch before the model call; then the loop's
  // second model call and another tool, each still fresh.
  const rows = [
    row("invoke_start", "trace-1", 1, 4_000),
    row("search", "trace-1", 2, 3_000),
    row("search", "trace-1", 3, 1_000),
    row("invoke_start", "trace-1", 3, 1_000),
  ];
  assert.equal(
    foldablePrefix(rows, now).held,
    4,
    "a tool call keeps the trace open: the cut is at its first row",
  );
  // Quiet for the grace: complete, whatever the row order.
  assert.equal(foldablePrefix(rows, now + 60_000).held, 0);
  // A trace older than the hold cap folds as far as it got, even while rows keep coming.
  const endless = [
    row("search", "trace-2", 1, 11 * 60_000),
    row("invoke_start", "trace-2", 2, 1_000),
  ];
  assert.equal(foldablePrefix(endless, now).held, 0);
  // An older complete trace ahead of a fresh one folds alone.
  const two = [
    row("search", "trace-3", 1, 90_000),
    row("invoke_start", "trace-3", 1, 90_000),
    row("search", "trace-4", 2, 2_000),
  ];
  assert.deepEqual(foldablePrefix(two, now), { fold: two.slice(0, 2), held: 1 });
});

/* — the OTLP lane: an ask and the tools it called ————————————————————————— */

const otlpAsk = (query: string, trace: string, at?: number) =>
  row({
    type: "search",
    lane: "otlp",
    query,
    origin: "baseline",
    topK: 0,
    turnId: trace,
    sessionId: trace,
    occurredAt: at === undefined ? null : new Date(at),
  });
const otlpCall = (toolId: string, trace: string, at?: number) =>
  row({
    type: "invoke_start",
    lane: "otlp",
    toolId,
    turnId: trace,
    sessionId: trace,
    occurredAt: at === undefined ? null : new Date(at),
  });

test("an OTLP trace learns each ask once with every tool it called; the loop's repeats are not learned again", () => {
  const rows = [
    otlpAsk("find my open tasks", "trace-1"),
    otlpCall("find_task", "trace-1"),
    otlpCall("list_sprints", "trace-1"),
    otlpAsk("find my open tasks", "trace-1"), // the loop's second model call
    otlpAsk("find my open tasks please", "trace-2"),
    otlpCall("find_task", "trace-2"),
    otlpAsk("something nobody acted on", "trace-3"),
  ];
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });
  assert.equal(out.recorded, 6, "the repeated ask is not recorded");
  assert.equal(out.repeated, 1);
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.recordedByLane, { runtime: 0, otlp: 6 });
  const graph = parse(out.json);
  assert.equal(graph.intents.length, 1, "two asks cluster, the unacted one forms nothing");
  const cluster = graph.intents[0]!;
  assert.deepEqual(cluster.tools, { find_task: 2, list_sprints: 1 });
  assert.deepEqual(cluster.members, ["find my open tasks", "find my open tasks please"]);
});

test("a second, different ask in the same trace opens its own turn and takes the tools that follow it", () => {
  const rows = [
    otlpAsk("find my open tasks", "trace-1"),
    otlpCall("find_task", "trace-1"),
    otlpAsk("find my open tasks", "trace-1"),
    otlpAsk("email the summary to the team", "trace-1"),
    otlpCall("send_email", "trace-1"),
  ];
  const out = foldEventsIntoGraph({ rows, hits: new Map(), baseJson: null });
  assert.equal(out.recorded, 4);
  assert.equal(out.repeated, 1);
  const graph = parse(out.json);
  assert.equal(graph.intents.length, 2);
  const byTool = Object.fromEntries(
    graph.intents.map((i) => [Object.keys(i.tools).join(","), i.members]),
  );
  assert.deepEqual(byTool, {
    find_task: ["find my open tasks"],
    send_email: ["email the summary to the team"],
  });
});

test("a trace's rows are learned in the order they happened, however the exporter batched them", () => {
  const t0 = 1_790_000_000_000;
  // The tool span's batch landed first; the model call's a moment later.
  const rows = [
    otlpCall("find_task", "trace-1", t0 + 1_000),
    otlpAsk("find my open tasks", "trace-1", t0),
    // A runtime turn in between keeps its own ingest order.
    row({ type: "search", query: "close the sprint", turnId: "t1" }),
    row({ type: "invoke_start", toolId: "close_sprint", turnId: "t1" }),
    otlpCall("list_sprints", "trace-1", t0 + 2_000),
  ];
  const out = foldEventsIntoGraph({ rows, hits: hitsFor(rows, ["close_sprint"]), baseJson: null });
  assert.equal(out.recorded, 5);
  const graph = parse(out.json);
  const tools = Object.fromEntries(graph.intents.map((i) => [i.members.join(), i.tools]));
  assert.deepEqual(tools, {
    "find my open tasks": { find_task: 1, list_sprints: 1 },
    "close the sprint": { close_sprint: 1 },
  });
});

/* — cloud shadow ————————————————————————————————————————————————————————— */

/** A tool as the shadow registries index it: what the match-quality reading's corpus loader yields. */
interface CorpusEntry {
  entryId: string;
  name: string;
  searchable: string;
}

/** The registry the match-quality replay builds over a corpus, reduced to what the fold needs. */
function registerAll(entries: readonly CorpusEntry[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    void registry.register({
      id: entry.entryId,
      name: entry.name,
      description: entry.searchable,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  }
  return registry;
}

const CORPUS: CorpusEntry[] = [
  ["docker_build", "Build a docker image from a Dockerfile"],
  ["gh_run_list", "List CI workflow runs and whether each build passed"],
  ["deploy_rollback", "Roll back a deployment to the previous release"],
  ["send_email", "Send an email to a recipient with a subject and body"],
].map(([entryId, searchable]) => ({
  entryId: entryId!,
  name: entryId!,
  searchable: searchable!,
}));

function shadowRegistries(): FoldShadow {
  return { plain: registerAll(CORPUS), boosted: registerAll(CORPUS) };
}

/** `times` turns of the same query, each invoking `tool`. */
function repeatedTurns(query: string, tool: string, times: number): FoldableEventRow[] {
  const rows: FoldableEventRow[] = [];
  for (let i = 0; i < times; i += 1) {
    const turnId = `turn-${query.length}-${i}`;
    rows.push(
      row({ type: "search", query, turnId }),
      row({ type: "invoke_start", toolId: tool, turnId }),
    );
  }
  return rows;
}

test("shadow ranks each search with the graph as it stood before it, and records the tool the agent then ran", () => {
  const query = "did the build pass on ci";
  // The tool the agent keeps choosing is the one a plain search does not put first.
  const plainOrder = registerAll(CORPUS)
    .searchWithOrigin(query, 5, "agent")
    .map((h) => h.toolId);
  assert.ok(plainOrder.length >= 2, "the query matches at least two tools");
  const chosen = plainOrder[1]!;
  const rows = repeatedTurns(query, chosen, 5);
  const out = foldEventsIntoGraph({
    rows,
    hits: hitsFor(rows, plainOrder),
    baseJson: null,
    shadow: shadowRegistries(),
  });

  assert.equal(out.shadowTurns.length, 5, "one row per search, none for invokes");
  const [first, ...later] = out.shadowTurns;
  assert.equal(first!.matched, false, "nothing had been learned before the first search");
  assert.deepEqual(first!.boostedIds, first!.plainIds, "so the boosted list is the plain one");
  assert.deepEqual(first!.plainIds, plainOrder);
  assert.ok(
    later.every((t) => t.invokedToolId === chosen),
    "each turn carries the tool its invoke named",
  );
  const last = later.at(-1)!;
  assert.equal(last.matched, true, "by the last search the query's cluster is known");
  assert.deepEqual(last.plainIds, plainOrder, "the plain list never changes");
  assert.ok(
    last.boostedIds.indexOf(chosen) < last.plainIds.indexOf(chosen),
    "the graph moved the chosen tool up",
  );
});

test("a search the runtime reported on is taken as is for the graph it ranks from, and replayed for any other", () => {
  const query = "did the build pass on ci";
  const served = ["gh_run_list", "docker_build", "send_email"];
  const base = ["docker_build", "gh_run_list", "deploy_rollback", "send_email"];
  const turnId = "turn-r";
  const rows = [
    row({ type: "search", query, turnId, baseHitIds: base }),
    row({ type: "invoke_start", toolId: "gh_run_list", turnId }),
  ];
  const hits = hitsFor(rows, served);
  const graphBySource = new Map([["acme-app", "cloud/acme-app"]]);

  // Its own graph: the runtime's two lists, no replay, live by the runtime's word.
  const plain = registerAll(CORPUS);
  const boosted = registerAll(CORPUS);
  let searches = 0;
  for (const registry of [plain, boosted]) {
    const original = registry.searchWithOrigin.bind(registry);
    registry.searchWithOrigin = ((...args: Parameters<typeof original>) => {
      searches += 1;
      return original(...args);
    }) as typeof registry.searchWithOrigin;
  }
  const own = foldEventsIntoGraph({
    rows,
    hits,
    baseJson: null,
    shadow: { plain, boosted },
    reports: { graphKey: "cloud/acme-app", graphBySource },
  });
  assert.equal(searches, 0, "no replay for a reported search");
  assert.deepEqual(own.shadowTurns, [
    {
      searchEventId: rows[0]!.id,
      sourceId: "acme-app",
      occurredAt: rows[0]!.receivedAt,
      plainIds: base,
      boostedIds: served,
      matched: true,
      reported: true,
      invokedToolId: "gh_run_list",
    },
  ]);

  // The merged graph: the runtime does not rank from it, so Cloud replays as before.
  const merged = foldEventsIntoGraph({
    rows,
    hits,
    baseJson: null,
    shadow: shadowRegistries(),
    reports: { graphKey: "cloud", graphBySource },
  });
  assert.equal(merged.shadowTurns[0]!.reported, false);
  assert.notDeepEqual(merged.shadowTurns[0]!.plainIds, base);

  // Without base_hits nothing changes, whatever the runtime ranks from.
  const plainRows = [
    row({ type: "search", query, turnId: "turn-p" }),
    row({ type: "invoke_start", toolId: "gh_run_list", turnId: "turn-p" }),
  ];
  const unreported = foldEventsIntoGraph({
    rows: plainRows,
    hits: hitsFor(plainRows, served),
    baseJson: null,
    shadow: shadowRegistries(),
    reports: { graphKey: "cloud/acme-app", graphBySource },
  });
  assert.equal(unreported.shadowTurns[0]!.reported, false);
});

test("shadow searches leave the graph exactly as a fold without them builds it", () => {
  const rows = [
    ...repeatedTurns("did the build pass on ci", "gh_run_list", 3),
    ...repeatedTurns("roll back the last deploy", "deploy_rollback", 2),
  ];
  const hits = hitsFor(rows, ["docker_build", "gh_run_list", "deploy_rollback"]);
  // Wall-clock stamps differ between two folds; everything the learner decided must not.
  const strip = (json: string) => {
    const doc = JSON.parse(json) as {
      built_from_ts?: number;
      intents: Array<{ last_ts?: number }>;
    };
    delete doc.built_from_ts;
    for (const intent of doc.intents) delete intent.last_ts;
    return doc;
  };
  const without = foldEventsIntoGraph({ rows, hits, baseJson: null });
  const withShadow = foldEventsIntoGraph({
    rows,
    hits,
    baseJson: null,
    shadow: shadowRegistries(),
  });
  assert.deepEqual(strip(withShadow.json), strip(without.json));
  assert.equal(without.shadowTurns.length, 0);
  assert.equal(withShadow.rev, without.rev);
});

test("the shadow registries can be reused across folds: the graph is detached after each", () => {
  const shadow = shadowRegistries();
  const rows = repeatedTurns("did the build pass on ci", "gh_run_list", 3);
  const hits = hitsFor(rows, ["docker_build", "gh_run_list"]);
  foldEventsIntoGraph({ rows, hits, baseJson: null, shadow });
  // A second, unrelated fold starts from an empty graph: no boost may leak from the first.
  const fresh = repeatedTurns("did the build pass on ci", "gh_run_list", 1);
  const again = foldEventsIntoGraph({
    rows: fresh,
    hits: hitsFor(fresh, ["docker_build"]),
    baseJson: null,
    shadow,
  });
  assert.equal(again.shadowTurns[0]!.matched, false);
  assert.deepEqual(again.shadowTurns[0]!.boostedIds, again.shadowTurns[0]!.plainIds);
});
