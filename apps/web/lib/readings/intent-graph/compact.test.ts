import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentGraph } from "@ratel-ai/sdk";
import {
  BRIDGE_MIN_SHARED,
  bridgeTokens,
  COMPACT_SETTLE_MS,
  compactIntentGraph,
  EDGE_AGREEMENT,
  MEMBER_CAP,
  passesCompactionGates,
  SUPPORT_FULL,
} from "@/lib/readings/intent-graph/compact";
import {
  type IntentGraphDocument,
  type IntentGraphIntent,
  intentGraphContentHash,
  validateIntentGraph,
} from "@/lib/readings/intent-types/wire";

function cluster(
  id: string,
  members: string[],
  tools: Record<string, number>,
  over: Partial<IntentGraphIntent> = {},
): IntentGraphIntent {
  const support = over.support ?? (Object.values(tools).reduce((a, b) => a + b, 0) || 1);
  return {
    id,
    label: members[0] ?? id,
    terms: [],
    members,
    support,
    tools,
    skills: {},
    last_ts: OBSERVED,
    ...over,
  };
}

/** Clusters were observed a month before the graph's newest fold, so all have settled. */
const OBSERVED = 1_700_000_000_000;
const BUILT = OBSERVED + 30 * 86_400_000;

function graph(
  intents: IntentGraphIntent[],
  over: Partial<IntentGraphDocument> = {},
): IntentGraphDocument {
  return { v: 1, built_from_ts: BUILT, rev: 7, intents, ...over };
}

/** The real-data shape from the local Acme project: one intent, many subject nouns. */
function fragmentedGraph(): IntentGraphDocument {
  return graph([
    cluster("intent_3", ["search tasks about Gemini 3.5 Flash model upgrade"], { search_tasks: 1 }),
    cluster(
      "intent_7",
      ["search tasks by text Ironclad"],
      { search_tasks: 1 },
      { last_ts: OBSERVED + 500 },
    ),
    cluster("intent_12", ["search tasks about invite workspace mcpjam"], { search_tasks: 1 }),
    cluster("intent_19", ["search tasks for Chroma canonical upsert deadline"], {
      search_tasks: 1,
    }),
    cluster(
      "intent_21",
      ["find task PAAW-7 competitive watch", "PAAW-7 competitive watch Positioning"],
      { search_tasks: 2 },
    ),
    cluster("intent_33", ["failing tests on main"], { search_tasks: 1 }),
    cluster(
      "intent_40",
      ["get task details by id", "get_task_by_id", "get full task"],
      { get_task: 5, search_tasks: 1 },
      { support: 6 },
    ),
    cluster("intent_55", ["search projects about billing"], { search_projects: 1 }),
  ]);
}

test("fragments that agree on their edge and share wording merge into one full-weight cluster", () => {
  const { graph: out, report } = compactIntentGraph(fragmentedGraph());
  assert.equal(report.before, 8);
  assert.equal(report.after, 5);
  assert.equal(report.merged, 3);
  assert.deepEqual(report.groups, [
    {
      survivor: "intent_3",
      absorbed: ["intent_7", "intent_12", "intent_19"],
      capability: "tool:search_tasks",
    },
  ]);
  const survivor = out.intents.find((it) => it.id === "intent_3")!;
  assert.equal(survivor.support, 4);
  assert.ok(survivor.support >= SUPPORT_FULL);
  assert.deepEqual(survivor.tools, { search_tasks: 4 });
  assert.equal(survivor.members.length, 4);
  // Survivor's members first, then the newest absorbed cluster.
  assert.equal(survivor.members[0], "search tasks about Gemini 3.5 Flash model upgrade");
  assert.equal(survivor.members[1], "search tasks by text Ironclad");
  assert.equal(survivor.last_ts, OBSERVED + 500);
  assert.deepEqual(out.intents.map((it) => it.id).sort(), [
    "intent_21",
    "intent_3",
    "intent_33",
    "intent_40",
    "intent_55",
  ]);
});

test("a one-off with the same edge but no shared wording is not absorbed", () => {
  const { graph: out } = compactIntentGraph(fragmentedGraph());
  const oneOff = out.intents.find((it) => it.id === "intent_33")!;
  assert.deepEqual(oneOff.members, ["failing tests on main"]);
  assert.equal(oneOff.support, 1);
});

test("a cluster whose edges point mostly elsewhere is not pulled in", () => {
  // {get_task: 5, search_tasks: 1} vs {search_tasks: 1}: cosine ≈ 0.2 < EDGE_AGREEMENT.
  const { graph: out } = compactIntentGraph(fragmentedGraph());
  const detail = out.intents.find((it) => it.id === "intent_40")!;
  assert.deepEqual(detail.tools, { get_task: 5, search_tasks: 1 });
  assert.equal(detail.support, 6);
  assert.ok(EDGE_AGREEMENT > 0.2);
});

test("ticket keys and digit tokens are ignored in the bridge, so one shared word is not a bridge", () => {
  assert.deepEqual(bridgeTokens("find task PAAW-7 competitive watch"), [
    "find",
    "task",
    "competitive",
    "watch",
  ]);
  assert.deepEqual(bridgeTokens("look up task RC-208 or 142YXqQ9"), ["look", "up", "task"]);
  const { graph: out } = compactIntentGraph(fragmentedGraph());
  // "find task …" shares only "task"/"tasks" (no stemming): one token short of BRIDGE_MIN_SHARED.
  assert.ok(BRIDGE_MIN_SHARED > 1);
  assert.ok(out.intents.some((it) => it.id === "intent_21" && it.support === 2));
});

test("the ID filter lets two asks about different records bridge on verb and object", () => {
  const { graph: out, report } = compactIntentGraph(
    graph([
      cluster("intent_1", ["look up task RC-208 details"], { get_task: 1 }),
      cluster("intent_2", ["look up task PAAW-7 details"], { get_task: 1 }),
    ]),
  );
  assert.equal(report.merged, 1);
  assert.equal(out.intents.length, 1);
  assert.equal(out.intents[0]!.support, 2);
});

test("a mature cluster absorbs immature siblings and keeps its id; two mature clusters never merge", () => {
  const { graph: out, report } = compactIntentGraph(
    graph([
      cluster("intent_1", ["search tasks about billing"], { search_tasks: 3 }, { support: 3 }),
      cluster("intent_2", ["search tasks about invoices"], { search_tasks: 1 }),
      cluster("intent_3", ["search tasks about refunds"], { search_tasks: 4 }, { support: 4 }),
    ]),
  );
  assert.equal(report.merged, 1);
  // The mature survivor is the one with the most support.
  assert.deepEqual(report.groups, [
    { survivor: "intent_3", absorbed: ["intent_2"], capability: "tool:search_tasks" },
  ]);
  assert.deepEqual(
    out.intents.map((it) => it.id),
    ["intent_1", "intent_3"],
  );
  assert.equal(out.intents[1]!.support, 5);
});

test("edge maps, seeded support and surfaced counts are summed", () => {
  const { graph: out } = compactIntentGraph(
    graph([
      cluster(
        "intent_1",
        ["search tasks about billing"],
        { search_tasks: 1 },
        { surfaced_tools: { search_tasks: 2, filter_tasks: 1 }, seeded_support: 1 },
      ),
      cluster(
        "intent_2",
        ["search tasks about invoices"],
        { search_tasks: 1 },
        { surfaced_tools: { filter_tasks: 3 }, skills: { triage: 0 } },
      ),
    ]),
  );
  const merged = out.intents[0]!;
  assert.deepEqual(merged.tools, { search_tasks: 2 });
  assert.deepEqual(merged.skills, {});
  assert.deepEqual(merged.surfaced_tools, { filter_tasks: 4, search_tasks: 2 });
  assert.equal(merged.seeded_support, 1);
  assert.equal(merged.support, 2);
});

test("the member union is capped at MEMBER_CAP keeping the survivor's members and the newest absorbed", () => {
  const many = (prefix: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `search tasks about ${prefix} ${"topic".repeat(1)} ${String.fromCharCode(97 + (i % 26))}${"x".repeat(Math.floor(i / 26))}`,
    );
  const { graph: out } = compactIntentGraph(
    graph([
      cluster("intent_1", many("alpha", 30), { search_tasks: 1 }),
      cluster("intent_2", many("old", 30), { search_tasks: 1 }, { last_ts: 1 }),
      cluster(
        "intent_3",
        many("new", 30),
        { search_tasks: 1 },
        { last_ts: OBSERVED + 10 * 86_400_000 },
      ),
    ]),
  );
  const merged = out.intents[0]!;
  assert.equal(merged.members.length, MEMBER_CAP);
  assert.ok(merged.members.slice(0, 30).every((m) => m.includes("alpha")));
  assert.ok(merged.members.slice(30).every((m) => m.includes("new")));
  assert.equal(merged.support, 3);
});

test("a fragment observed within the settling time is not absorbed; settleMs 0 absorbs it at once", () => {
  const doc = graph([
    cluster("intent_1", ["search tasks about billing"], { search_tasks: 1 }),
    cluster(
      "intent_2",
      ["search tasks about invoices"],
      { search_tasks: 1 },
      { last_ts: BUILT - COMPACT_SETTLE_MS + 1 },
    ),
    cluster(
      "intent_3",
      ["search tasks about refunds"],
      { search_tasks: 1 },
      { last_ts: BUILT - COMPACT_SETTLE_MS },
    ),
  ]);
  const gated = compactIntentGraph(doc);
  assert.deepEqual(gated.report.groups, [
    { survivor: "intent_1", absorbed: ["intent_3"], capability: "tool:search_tasks" },
  ]);
  assert.ok(gated.graph.intents.some((it) => it.id === "intent_2" && it.support === 1));
  const now = compactIntentGraph(doc, { settleMs: 0 });
  assert.equal(now.report.merged, 2);
});

test("a component with a centroid-bearing cluster is left alone", () => {
  const doc = graph(
    [
      cluster(
        "intent_1",
        ["search tasks about billing"],
        { search_tasks: 1 },
        { centroid: [1, 0, 0] },
      ),
      cluster("intent_2", ["search tasks about invoices"], { search_tasks: 1 }),
    ],
    { model: "test-model" },
  );
  const result = compactIntentGraph(doc);
  assert.equal(result.graph, doc);
  assert.equal(result.report.merged, 0);
});

test("a tool edge and a skill edge with the same id never group", () => {
  const result = compactIntentGraph(
    graph([
      cluster("intent_1", ["search tasks about billing"], { triage: 1 }),
      cluster("intent_2", ["search tasks about invoices"], {}, { skills: { triage: 1 } }),
    ]),
  );
  assert.equal(result.report.merged, 0);
});

test("the output is accepted by the SDK, validates on Cloud, and carries recomputed labels and terms", () => {
  const { graph: out } = compactIntentGraph(fragmentedGraph());
  const validation = validateIntentGraph(out);
  assert.ok(validation.ok, validation.ok ? "" : validation.details.join("; "));
  const loaded = IntentGraph.fromJson(JSON.stringify(out));
  assert.equal(loaded.clusterCount, 5);
  assert.equal(out.rev, 7);
  const survivor = out.intents.find((it) => it.id === "intent_3")!;
  assert.ok(survivor.members.includes(survivor.label));
  assert.ok(survivor.terms.includes("search") || survivor.terms.includes("tasks"));
});

test("compaction is idempotent and deterministic", () => {
  const once = compactIntentGraph(fragmentedGraph());
  const twice = compactIntentGraph(once.graph);
  assert.equal(twice.graph, once.graph);
  assert.equal(twice.report.merged, 0);
  const again = compactIntentGraph(fragmentedGraph());
  assert.equal(intentGraphContentHash(again.graph), intentGraphContentHash(once.graph));
});

test("empty and single-cluster graphs are returned as is", () => {
  const empty = graph([]);
  assert.equal(compactIntentGraph(empty).graph, empty);
  const single = graph([cluster("intent_1", ["search tasks"], { search_tasks: 1 })]);
  assert.equal(compactIntentGraph(single).graph, single);
});

test("a bridge that is not absorbed cannot merge two clusters that share no wording", () => {
  // A~B and B~C pass pairwise, A~C does not. B is fresh, so it is left alone;
  // C must then pass against A on its own, and it does not.
  const doc = graph([
    cluster("intent_1", ["search tasks billing"], { search_tasks: 1 }),
    cluster("intent_3", ["search tasks failing tests"], { search_tasks: 1 }, { last_ts: BUILT }),
    cluster("intent_5", ["failing tests on main"], { search_tasks: 1 }),
  ]);
  const result = compactIntentGraph(doc);
  assert.equal(result.graph, doc);
  assert.equal(result.report.merged, 0);
});

test("a settled hub joins the survivor, but a cluster that only matches the hub stays out", () => {
  const { graph: out, report } = compactIntentGraph(
    graph([
      cluster("intent_1", ["search tasks billing"], { search_tasks: 1 }),
      cluster("intent_3", ["search tasks failing tests"], { search_tasks: 1 }),
      cluster("intent_5", ["failing tests on main"], { search_tasks: 1 }),
    ]),
  );
  assert.deepEqual(report.groups, [
    { survivor: "intent_1", absorbed: ["intent_3"], capability: "tool:search_tasks" },
  ]);
  assert.ok(out.intents.some((it) => it.id === "intent_5" && it.support === 1));
});

test("a fresh fragment neither absorbs nor is absorbed, even when it would be the preferred survivor", () => {
  const { report } = compactIntentGraph(
    graph([
      cluster(
        "intent_1",
        ["search tasks billing", "search tasks refunds"],
        { search_tasks: 2 },
        { last_ts: BUILT },
      ),
      cluster("intent_2", ["search tasks invoices"], { search_tasks: 1 }),
      cluster("intent_3", ["search tasks credits"], { search_tasks: 1 }),
    ]),
  );
  assert.deepEqual(report.groups, [
    { survivor: "intent_2", absorbed: ["intent_3"], capability: "tool:search_tasks" },
  ]);
});

test("invariant: every absorbed cluster passes both gates directly against its survivor", () => {
  const docs = [
    fragmentedGraph(),
    graph([
      cluster("intent_1", ["search tasks billing"], { search_tasks: 1 }),
      cluster("intent_2", ["search tasks failing tests"], { search_tasks: 1 }),
      cluster("intent_3", ["failing tests on main"], { search_tasks: 1 }),
      cluster("intent_4", ["tasks billing failing tests"], { search_tasks: 1 }),
      cluster("intent_5", ["search tasks about refunds"], { search_tasks: 3 }, { support: 3 }),
      cluster(
        "intent_6",
        ["list open tasks"],
        { search_tasks: 1, filter_tasks: 1 },
        { support: 2 },
      ),
    ]),
  ];
  for (const doc of docs) {
    const byId = new Map(doc.intents.map((it) => [it.id, it]));
    const { report } = compactIntentGraph(doc, { settleMs: 0 });
    assert.ok(report.groups.length > 0);
    for (const group of report.groups) {
      const survivor = byId.get(group.survivor)!;
      for (const id of group.absorbed) {
        assert.ok(
          passesCompactionGates(survivor, byId.get(id)!),
          `${id} absorbed into ${group.survivor} without passing the gates`,
        );
      }
    }
  }
});
