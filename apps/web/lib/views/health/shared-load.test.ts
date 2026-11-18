import assert from "node:assert/strict";
import { test } from "node:test";
import { healthScoreView } from "@/lib/readings/trace-signals/health-score";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import {
  createModelCache,
  loadSharedHealth,
  SHARED_MODEL_TTL_MS,
  type SharedHealthDeps,
} from "@/lib/views/health/shared-load";

const LINK = {
  linkId: "link-1",
  windowDays: 30,
  project: { id: "project-1", name: "Support Copilot" },
  organization: { id: "org-1", name: "Acme", slug: "acme" },
};
const LIMITS = {
  agentHealthWindowDays: 30,
  agentHealthSignalsShown: 5,
  agentHealthEvidenceTurns: 3,
};

function harness(over: Partial<SharedHealthDeps> = {}) {
  const asked: string[] = [];
  const loads: { projectId: string; windowDays: number; evidenceTurns: number }[] = [];
  let clock = 1_000;
  const deps: SharedHealthDeps = {
    resolve: async (token) => {
      asked.push(token);
      return LINK;
    },
    getLimits: () => LIMITS,
    loadModel: async ({ projectId, windowDays, limits }) => {
      loads.push({ projectId, windowDays, evidenceTurns: limits.agentHealthEvidenceTurns });
      return pendingHealthModel(windowDays);
    },
    cache: createModelCache(),
    now: () => clock,
    ...over,
  };
  return {
    deps,
    asked,
    loads,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

test("a token the edition does not know is nothing, and no model is built", async () => {
  const { deps, loads } = harness({ resolve: async () => null });
  assert.equal(await loadSharedHealth("unknown", deps), null);
  assert.deepEqual(loads, []);
});

test("a live link opens its project's model on the link's window, with whose it is", async () => {
  const { deps, asked, loads } = harness();
  const shared = await loadSharedHealth("tok", deps);
  assert.deepEqual(asked, ["tok"]);
  assert.deepEqual(loads, [{ projectId: "project-1", windowDays: 30, evidenceTurns: 3 }]);
  assert.equal(shared?.linkId, "link-1");
  assert.equal(shared?.projectId, "project-1");
  assert.equal(shared?.organizationId, "org-1");
  assert.equal(shared?.projectName, "Support Copilot");
  assert.equal(shared?.organizationName, "Acme");
  assert.equal(shared?.model.windowDays, 30);
});

test("the window is cut to the plan as it is now, not as it was when the link was made", async () => {
  const { deps, loads } = harness({ getLimits: () => ({ ...LIMITS, agentHealthWindowDays: 7 }) });
  const shared = await loadSharedHealth("tok", deps);
  assert.equal(loads[0]?.windowDays, 7);
  assert.equal(shared?.model.windowDays, 7);
});

test("a busy link builds its model once a minute; the token is still checked on every view", async () => {
  const { deps, asked, loads, tick } = harness();
  await loadSharedHealth("tok", deps);
  tick(SHARED_MODEL_TTL_MS - 1);
  await loadSharedHealth("tok", deps);
  assert.equal(loads.length, 1);
  assert.equal(asked.length, 2);
  tick(2);
  await loadSharedHealth("tok", deps);
  assert.equal(loads.length, 2);
});

test("a revoked link stops at once, whatever is cached", async () => {
  let live = true;
  const { deps, loads } = harness({ resolve: async () => (live ? LINK : null) });
  assert.notEqual(await loadSharedHealth("tok", deps), null);
  live = false;
  assert.equal(await loadSharedHealth("tok", deps), null);
  assert.equal(loads.length, 1);
});

test("a failed build is not cached: the next view tries again", async () => {
  let fail = true;
  const { deps } = harness({
    loadModel: async ({ windowDays }) => {
      if (fail) throw new Error("database is down");
      return pendingHealthModel(windowDays);
    },
  });
  await assert.rejects(loadSharedHealth("tok", deps), /database is down/);
  fail = false;
  assert.notEqual(await loadSharedHealth("tok", deps), null);
});

test("the cache keeps the newest links and drops the oldest past its cap", async () => {
  const cache = createModelCache(1_000, 2);
  const built: string[] = [];
  const build = (key: string) => async () => {
    built.push(key);
    return pendingHealthModel(7);
  };
  await cache.get("a", 0, build("a"));
  await cache.get("b", 0, build("b"));
  await cache.get("c", 0, build("c"));
  await cache.get("a", 0, build("a"));
  assert.deepEqual(built, ["a", "b", "c", "a"]);
  await cache.get("c", 0, build("c"));
  assert.deepEqual(built, ["a", "b", "c", "a"]);
});

/** A model with a score as the page would build it: no open issue and two measured rates. */
function scoredModel() {
  const pillars = [
    { pillar: "ended" as const, good: 0.97, n: 500 },
    { pillar: "top_5" as const, good: 0.84, n: 500 },
  ];
  return { ...pendingHealthModel(30), score: healthScoreView([], 500, [], pillars) };
}

test("a public link shows the Health score (RC-226)", async () => {
  const model = scoredModel();
  assert.ok(model.score, "the fixture has a score");
  const shared = await loadSharedHealth("tok", harness({ loadModel: async () => model }).deps);
  assert.equal(shared?.model.score?.value, model.score?.value);
  assert.deepEqual(shared?.model.score?.pillars, model.score?.pillars, "with what it is made of");
});
