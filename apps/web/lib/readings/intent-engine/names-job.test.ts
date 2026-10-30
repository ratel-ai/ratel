import assert from "node:assert/strict";
import { test } from "node:test";
import { nameHash, namePhrases } from "@/lib/readings/intent-engine/names";
import {
  applyCachedIntentNames,
  cachedClusterKey,
  cachedClusterName,
  DEFAULT_MAX_NAMES,
  defaultNameDeps,
  maxNamesPerRun,
  type NameCache,
  type NameCandidate,
  type NamesComplete,
  NamesCutOffError,
  NamesDeclinedError,
  nameCandidates,
  nameEngineClusters,
  nameModel,
} from "@/lib/readings/intent-engine/names-job";
import type { EngineDb } from "@/lib/readings/intent-engine/store";
import type { EngineCluster, LevelTree } from "@/lib/readings/intent-types/engine-types";

const members = ["give Ada the onboarding checklist", "give Chen the onboarding checklist"];
const cluster = { uuid: "q1", members, asks: 2 } as EngineCluster;
const key = { action: "assign", object: "checklist" };

function tree(label = "rule label"): LevelTree {
  return {
    levels: [[], [{ uuid: "i1", level: 1, children: ["q1"], label, terms: [] }]],
    parentOf: new Map([["q1", "i1"]]),
  };
}

test("a cached level-0 name stands under either prompt; a key only under the keyed one", () => {
  const plain: NameCache = new Map([
    ["q1", { label: "Assign a checklist", hash: nameHash(0, namePhrases(members)), key }],
  ]);
  assert.equal(
    cachedClusterName(plain, cluster),
    "Assign a checklist",
    "named before keys were on",
  );
  assert.equal(
    cachedClusterKey(plain, cluster),
    null,
    "a key was never asked for under that prompt",
  );

  const keyed: NameCache = new Map([
    ["q1", { label: "Assign a checklist", hash: nameHash(0, namePhrases(members), true), key }],
  ]);
  assert.equal(
    cachedClusterName(keyed, cluster),
    "Assign a checklist",
    "named with keys on, read with keys off or on",
  );
  assert.deepEqual(cachedClusterKey(keyed, cluster), key);

  const stale: NameCache = new Map([
    ["q1", { label: "Old name", hash: nameHash(0, ["something else"]), key }],
  ]);
  assert.equal(cachedClusterName(stale, cluster), null, "the phrases moved on");
  assert.equal(cachedClusterKey(stale, cluster), null);
});

test("an intent keeps its model name, even while a new one is due", () => {
  const fresh = tree();
  applyCachedIntentNames(
    fresh,
    new Map([
      [
        "i1",
        { label: "Assign checklists", hash: nameHash(1, namePhrases(members), true), key: null },
      ],
    ]),
  );
  assert.equal(fresh.levels[1][0].label, "Assign checklists");

  const moved = tree();
  const cache: NameCache = new Map([
    ["i1", { label: "Assign checklists", hash: nameHash(1, ["older phrases"]), key: null }],
  ]);
  applyCachedIntentNames(moved, cache);
  assert.equal(
    moved.levels[1][0].label,
    "Assign checklists",
    "no flicker back to the rule-based name",
  );
  const due = nameCandidates(moved, [cluster], cache, { levels: [1], keyed: false });
  assert.deepEqual(
    due.map((c) => [c.id, c.named]),
    [["i1", true]],
    "and it is queued for a new name",
  );
});

test("candidates: first names before renames, intents only unless keyed, busiest first, cached ones skipped", () => {
  const c2 = { uuid: "q2", members: ["list overdue tasks"], asks: 9 } as EngineCluster;
  const t: LevelTree = {
    levels: [
      [],
      [
        { uuid: "i1", level: 1, children: ["q1"], label: "a", terms: [] },
        { uuid: "i2", level: 1, children: ["q2"], label: "b", terms: [] },
        { uuid: "i3", level: 1, children: ["q1", "q2"], label: "c", terms: [] },
      ],
    ],
    parentOf: new Map(),
  };
  const cache: NameCache = new Map([
    ["i1", { label: "Named", hash: nameHash(1, namePhrases(members)), key: null }],
    ["i3", { label: "Stale", hash: "old", key: null }],
  ]);
  const plain = nameCandidates(t, [cluster, c2], cache, { levels: [1], keyed: false });
  assert.deepEqual(
    plain.map((c) => c.id),
    ["i2", "i3"],
    "i1 is fresh; the never-named one goes first",
  );
  const keyed = nameCandidates(t, [cluster, c2], cache, { levels: [0, 1], keyed: true });
  assert.deepEqual(
    keyed.map((c) => c.id),
    ["i2", "q2", "q1", "i3", "i1"],
    "keyed: plain-prompt names are due again, behind every first name",
  );
});

test("the cap is INTENT_ENGINE_MAX_NAMES, one batch by default, and 0 turns naming off", () => {
  assert.equal(maxNamesPerRun({}), DEFAULT_MAX_NAMES);
  assert.equal(maxNamesPerRun({ INTENT_ENGINE_MAX_NAMES: "0" }), 0);
  assert.equal(maxNamesPerRun({ INTENT_ENGINE_MAX_NAMES: "45.7" }), 45);
  assert.equal(
    maxNamesPerRun({ INTENT_ENGINE_MAX_NAMES: "-3" }),
    DEFAULT_MAX_NAMES,
    "nonsense keeps the default",
  );
  assert.equal(nameModel({}), "claude-sonnet-5", "the topics namer's model");
  assert.equal(nameModel({ TOPICS_LABEL_MODEL: "m-topics" }), "m-topics");
  assert.equal(
    nameModel({ INTENT_ENGINE_NAME_MODEL: "m-engine", TOPICS_LABEL_MODEL: "m-topics" }),
    "m-engine",
  );
  assert.equal(defaultNameDeps({}).complete, null, "no key, no client");
  assert.equal(
    defaultNameDeps({ ANTHROPIC_API_KEY: "REPLACE_ME" }).complete,
    null,
    "the placeholder is no key",
  );
});

/** A transaction stub that records the names written. */
function recordingDb(): { db: Pick<EngineDb, "transaction">; writes: number } {
  const state = { writes: 0 };
  const tx = {
    execute: async () => ({ rows: [] }),
    update: () => ({
      set: () => ({
        where: async () => {
          state.writes += 1;
        },
      }),
    }),
  };
  const db = {
    transaction: async (run: (t: unknown) => Promise<unknown>) => run(tx),
  } as unknown as Pick<EngineDb, "transaction">;
  return {
    db,
    get writes() {
      return state.writes;
    },
  };
}

const candidate = (i: number): NameCandidate => ({
  id: `n${i}`,
  level: 1,
  phrases: [`ask number ${i}`],
  hash: `h${i}`,
  weight: 100 - i,
  named: false,
});

const answering: NamesComplete = async (_system, user) => {
  const ids = [...user.matchAll(/<cluster id="(c\d+)"/g)].map(([, id]) => id);
  return JSON.stringify({ names: ids.map((id) => ({ id, name: `Name ${id}` })) });
};

test("no key or a zero cap makes no call", async () => {
  const { db } = recordingDb();
  const none = await nameEngineClusters("p", db, { model: "m", complete: null, maxNames: 20 }, [
    candidate(1),
  ]);
  assert.equal(none.skipped, "no_model");
  let calls = 0;
  const off = await nameEngineClusters(
    "p",
    db,
    {
      model: "m",
      complete: async () => {
        calls += 1;
        return "";
      },
      maxNames: 0,
    },
    [candidate(1)],
  );
  assert.equal(off.skipped, "disabled");
  assert.equal(calls, 0);
});

test("a cut-off reply is counted, never dropped silently, and its batch is tried again in halves", async () => {
  const rec = recordingDb();
  const sizes: number[] = [];
  const complete: NamesComplete = async (system, user, keyed) => {
    const n = [...user.matchAll(/<cluster id=/g)].length;
    sizes.push(n);
    if (n > 2) throw new NamesCutOffError();
    return answering(system, user, keyed);
  };
  const result = await nameEngineClusters(
    "p",
    rec.db,
    { model: "m", complete, maxNames: 20 },
    [1, 2, 3, 4].map(candidate),
  );
  assert.deepEqual(sizes, [4, 2, 2]);
  assert.equal(result.cutOffCalls, 1);
  assert.equal(result.calls, 3);
  assert.equal(result.named, 4, "both halves named");
  assert.equal(rec.writes, 4);
});

test("a half that is cut off again is counted and left for the next pass", async () => {
  const rec = recordingDb();
  const result = await nameEngineClusters(
    "p",
    rec.db,
    {
      model: "m",
      complete: async () => {
        throw new NamesCutOffError();
      },
      maxNames: 20,
    },
    [1, 2, 3].map(candidate),
  );
  assert.equal(result.calls, 3, "the batch, then its two halves, no deeper");
  assert.equal(result.cutOffCalls, 3);
  assert.equal(result.named, 0);
  assert.equal(rec.writes, 0);
});

test("refusals, failures and unusable replies each have their own count; the cap bounds the clusters sent", async () => {
  const rec = recordingDb();
  let call = 0;
  const complete: NamesComplete = async (system, user, keyed) => {
    call += 1;
    if (call === 1) throw new NamesDeclinedError();
    if (call === 2) throw new Error("overloaded");
    if (call === 3) return "not json";
    return answering(system, user, keyed);
  };
  const result = await nameEngineClusters(
    "p",
    rec.db,
    { model: "m", complete, maxNames: 4 },
    [1, 2, 3, 4, 5, 6].map(candidate),
  );
  // Cap 4 at one per batch would be four calls; batches are 20, so the cap of 4 is one call.
  assert.equal(result.calls, 1);
  assert.equal(result.declinedCalls, 1);
  assert.equal(result.candidates, 6);
  const again = await nameEngineClusters(
    "p",
    rec.db,
    { model: "m", complete, maxNames: 4 },
    [1].map(candidate),
  );
  assert.equal(again.failedCalls, 1);
  const third = await nameEngineClusters(
    "p",
    rec.db,
    { model: "m", complete, maxNames: 4 },
    [1].map(candidate),
  );
  assert.equal(third.unusableCalls, 1);
  const fourth = await nameEngineClusters(
    "p",
    rec.db,
    { model: "m", complete, maxNames: 4 },
    [1, 2].map(candidate),
  );
  assert.equal(fourth.named, 2);
});
