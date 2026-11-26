import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES, type BearerRoute } from "@/lib/platform/api-keys/routes";
import { createDrizzleBaselineStore } from "../adapters/drizzle-baseline-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import {
  type BaselineConsoleDeps,
  type BaselineKeyDeps,
  handleCompareByKey,
  handleCompareByMember,
  handleGetBaselineByKey,
  handlePinByKey,
  handlePinByMember,
  handleUnpinByKey,
  handleUnpinByMember,
} from "../baseline-api";
import type { CaseScorer } from "../domain/case";
import { unscored } from "../domain/experiment";
import { snapshotOf, type TrialResult } from "../domain/score";
import { createEvalsDb, NO_REFUND, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

const CASE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-25T10:00:00Z");
const COMPARE = "GET /api/v1/evals/experiments/[experimentId]/comparison";

async function setup() {
  const { db } = await createEvalsDb();
  const experiments = createDrizzleExperimentStore(db);
  const baselines = createDrizzleBaselineStore(db);
  const events: string[] = [];
  const deps = {
    baselines: () => ({ baselines, experiments, now: () => NOW }),
    track: async (name: string, _subject: unknown, { surface }: { surface: string }) => {
      events.push(`${name} ${surface}`);
    },
    publicUrl: (path: string) => `https://ratel.test${path}`,
  };
  const key = (
    route: BearerRoute = COMPARE,
    { projectId = PROJECT_ID, scopes = ["*"] }: { projectId?: string; scopes?: string[] } = {},
    over: Partial<BaselineKeyDeps> = {},
  ): BaselineKeyDeps => ({
    ...deps,
    offForAll: () => false,
    // The real key check over a fake key.
    authenticate: () =>
      resolveProjectFromBearer(
        new Request("http://x", { headers: { authorization: "Bearer rtl_key" } }),
        BEARER_ROUTE_SCOPES[route],
        {
          isDbConfigured: () => true,
          hashApiKey: (plaintext) => plaintext,
          findActiveApiKeyByHash: async () => ({
            id: "99999999-9999-4999-8999-999999999999",
            keyPrefix: "rtl",
            rateLimitPerMinute: null,
            projectId,
            scopes,
          }),
          touchApiKey: async () => {},
        },
      ),
    enabled: async () => true,
    organizationIdOf: async () => ORGANIZATION_ID,
    ...over,
  });
  const member = (over: Partial<BaselineConsoleDeps> = {}): BaselineConsoleDeps => ({
    ...deps,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORGANIZATION_ID },
      role: "member",
    }),
    enabled: async () => true,
    isRestricted: async () => false,
    ...over,
  });
  /** An experiment with one case. It ends when it has results. */
  const experiment = async (
    results: TrialResult[],
    { scorers = [NO_REFUND], end = true }: { scorers?: CaseScorer[]; end?: boolean } = {},
  ) => {
    const versionId = crypto.randomUUID();
    const made = await experiments.create(
      {
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        sandboxVersionId: crypto.randomUUID(),
        sandboxName: "support-demo",
        name: null,
        labelFilter: null,
        gitCommit: "b".repeat(40),
        gitDirty: false,
        params: {},
        trialsPerCase: results.length,
        caseVersions: [{ caseId: CASE_ID, versionId, number: 1, name: "late order" }],
        scorerSnapshots: { [versionId]: scorers.map(snapshotOf) },
        startedBy: "user_1",
      },
      100,
    );
    assert.ok(made);
    if (!end) return made.id;
    for (const [index, trial] of (await experiments.trials(made.id)).entries()) {
      await experiments.finish(
        trial.id,
        unscored(results[index] ?? "invalid", "captured reason", { output: "captured answer" }),
      );
    }
    assert.ok(await experiments.close(made.id, NOW));
    return made.id;
  };
  return { experiment, baselines, key, member, events };
}

const UNPIN = new Request("http://x", { method: "DELETE" });
const pin = (experimentId: unknown) =>
  new Request("http://x", { method: "PUT", body: JSON.stringify({ experimentId }) });

test("a person pins a completed experiment. The pin stores who and when", async () => {
  const t = await setup();
  const id = await t.experiment(["pass"]);
  const response = await handlePinByMember(pin(id), PROJECT_ID, t.member());
  assert.equal(response.status, 200);
  assert.deepEqual(await t.baselines.get(PROJECT_ID), {
    experimentId: id,
    pinnedBy: "user_1",
    pinnedAt: NOW,
  });
  assert.equal(await t.baselines.get(OTHER_PROJECT_ID), null);
  const next = await t.experiment(["pass"]);
  const byKey = await handlePinByKey(pin(next), t.key("PUT /api/v1/evals/baseline"));
  assert.equal((await byKey.json()).baseline.pinnedBy, "key:99999999-9999-4999-8999-999999999999");
  assert.equal((await t.baselines.get(PROJECT_ID))?.experimentId, next);
  assert.deepEqual(t.events, ["eval_baseline_pinned console", "eval_baseline_pinned api"]);
});

test("nothing pins a baseline automatically: not a start, not an end, not a comparison", async () => {
  const t = await setup();
  const id = await t.experiment(["pass"]);
  const response = await handleCompareByKey(id, t.key());
  assert.deepEqual([response.status, (await response.json()).error], [409, "no_baseline"]);
  const read = await handleGetBaselineByKey(t.key("GET /api/v1/evals/baseline"));
  assert.deepEqual(await read.json(), { baseline: null });
  assert.equal(await t.baselines.get(PROJECT_ID), null);
});

test("a pin is refused for a running, an unknown and a foreign experiment, and a wrong body", async () => {
  const t = await setup();
  const running = await t.experiment(["pass"], { end: false });
  const done = await t.experiment(["pass"]);
  const status = async (body: unknown, projectId = PROJECT_ID) =>
    (await handlePinByMember(pin(body), projectId, t.member())).status;
  assert.equal(await status(running), 409);
  assert.equal(await status(CASE_ID), 404);
  assert.equal(await status("nope"), 400);
  assert.equal(await status(done, OTHER_PROJECT_ID), 404);
  assert.equal(await t.baselines.get(PROJECT_ID), null);
  assert.equal(await t.baselines.get(OTHER_PROJECT_ID), null);
});

test("a person removes the pin", async () => {
  const t = await setup();
  const id = await t.experiment(["pass"]);
  await handlePinByMember(pin(id), PROJECT_ID, t.member());
  assert.equal((await handleUnpinByMember(UNPIN, PROJECT_ID, t.member())).status, 200);
  assert.equal(await t.baselines.get(PROJECT_ID), null);
  const again = await handleUnpinByKey(UNPIN, t.key("DELETE /api/v1/evals/baseline"));
  assert.equal(again.status, 200);
  assert.deepEqual(t.events, ["eval_baseline_pinned console", "eval_baseline_unpinned console"]);
});

test("an unpin from a stale page does not remove the pin of another person", async () => {
  const t = await setup();
  const [mine, theirs] = [await t.experiment(["pass"]), await t.experiment(["pass"])];
  await handlePinByMember(pin(theirs), PROJECT_ID, t.member());
  const unpin = (experimentId: string) =>
    new Request(`http://x/?experimentId=${experimentId}`, { method: "DELETE" });
  const stale = await handleUnpinByMember(unpin(mine), PROJECT_ID, t.member());
  assert.deepEqual([stale.status, (await stale.json()).error], [409, "changed"]);
  assert.equal((await t.baselines.get(PROJECT_ID))?.experimentId, theirs);
  const wrong = await handleUnpinByMember(unpin("x"), PROJECT_ID, t.member());
  assert.equal(wrong.status, 400);
  assert.equal((await handleUnpinByMember(unpin(theirs), PROJECT_ID, t.member())).status, 200);
  assert.equal(await t.baselines.get(PROJECT_ID), null);
});

test("the comparison has the verdict, the rule and the changed cases, with no captured text", async () => {
  const t = await setup();
  const base = await t.experiment(["pass", "pass"]);
  const next = await t.experiment(["pass", "fail"]);
  await handlePinByMember(pin(base), PROJECT_ID, t.member());
  const response = await handleCompareByKey(next, t.key());
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes("captured"));
  const view = JSON.parse(text);
  assert.equal(view.verdict, "regressed");
  assert.match(view.rule, /^Regressed: a case went from pass to fail\./);
  assert.equal(view.baseline.experimentId, base);
  assert.equal(
    view.url,
    `https://ratel.test/project/${PROJECT_ID}/evals/experiments/${next}/compare`,
  );
  assert.deepEqual(
    [view.changedCases.length, view.changedCases[0].name, view.changedCases[0].change],
    [1, "late order", "regressed"],
  );
  assert.deepEqual(view.changedCases[0].candidate.counts, {
    pass: 1,
    fail: 1,
    invalid: 0,
    open: 0,
  });
  assert.deepEqual(view.otherCases, []);
  assert.equal(await (await handleCompareByKey(next, t.key())).text(), text);
  const byMember = await handleCompareByMember(PROJECT_ID, next, t.member());
  assert.equal(await byMember.text(), text);
});

test("other scorers are refused with the reason and the names", async () => {
  const t = await setup();
  const base = await t.experiment(["pass"]);
  const next = await t.experiment(["pass"], {
    scorers: [{ ...NO_REFUND, gating: false }],
  });
  await handlePinByMember(pin(base), PROJECT_ID, t.member());
  const response = await handleCompareByKey(next, t.key());
  const body = await response.json();
  assert.deepEqual([response.status, body.error], [409, "scorers_differ"]);
  assert.deepEqual(body.scorers, [
    { caseId: CASE_ID, caseName: "late order", name: "No refund", difference: "gating" },
  ]);
  assert.match(body.message, /No refund/);
  assert.equal(body.baseline.experimentId, base);
});

test("the baseline itself and a running experiment are refused", async () => {
  const t = await setup();
  const base = await t.experiment(["pass"]);
  const running = await t.experiment(["pass"], { end: false });
  await handlePinByMember(pin(base), PROJECT_ID, t.member());
  for (const [id, error] of [
    [base, "same_experiment"],
    [running, "not_completed"],
  ] as const) {
    const response = await handleCompareByKey(id, t.key());
    assert.deepEqual([response.status, (await response.json()).error], [409, error]);
  }
});

test("a key of another project reads no comparison and no baseline, and cannot pin", async () => {
  const t = await setup();
  const base = await t.experiment(["pass"]);
  const next = await t.experiment(["fail"]);
  await handlePinByMember(pin(base), PROJECT_ID, t.member());
  const other = { projectId: OTHER_PROJECT_ID };
  assert.equal((await handleCompareByKey(next, t.key(COMPARE, other))).status, 404);
  const read = await handleGetBaselineByKey(t.key("GET /api/v1/evals/baseline", other));
  assert.deepEqual(await read.json(), { baseline: null });
  const put = await handlePinByKey(pin(next), t.key("PUT /api/v1/evals/baseline", other));
  assert.equal(put.status, 404);
  await handleUnpinByKey(UNPIN, t.key("DELETE /api/v1/evals/baseline", other));
  assert.equal((await t.baselines.get(PROJECT_ID))?.experimentId, base);
});

test("a read key cannot pin, and a write key cannot read a comparison", async () => {
  const t = await setup();
  const id = await t.experiment(["pass"]);
  const read = { scopes: ["evals:read"] };
  const write = { scopes: ["evals:write"] };
  assert.equal(
    (await handlePinByKey(pin(id), t.key("PUT /api/v1/evals/baseline", read))).status,
    403,
  );
  assert.equal(
    (await handleUnpinByKey(UNPIN, t.key("DELETE /api/v1/evals/baseline", read))).status,
    403,
  );
  assert.equal((await handleCompareByKey(id, t.key(COMPARE, write))).status, 403);
  assert.equal(await t.baselines.get(PROJECT_ID), null);
});

test("with the flag off the routes answer 404, and a support session cannot pin", async () => {
  const t = await setup();
  const id = await t.experiment(["pass"]);
  for (const off of [{ offForAll: () => true }, { enabled: async () => false }]) {
    const deps = t.key(COMPARE, {}, off);
    for (const response of [
      await handleCompareByKey(id, deps),
      await handleGetBaselineByKey(deps),
      await handlePinByKey(pin(id), deps),
      await handleUnpinByKey(UNPIN, deps),
    ]) {
      assert.equal(response.status, 404);
    }
  }
  const off = t.member({ enabled: async () => false });
  assert.equal((await handlePinByMember(pin(id), PROJECT_ID, off)).status, 404);
  assert.equal((await handleCompareByMember(PROJECT_ID, id, off)).status, 404);
  const support = t.member({ isRestricted: async () => true });
  assert.equal((await handlePinByMember(pin(id), PROJECT_ID, support)).status, 403);
  assert.equal((await handleUnpinByMember(UNPIN, PROJECT_ID, support)).status, 403);
  assert.equal(await t.baselines.get(PROJECT_ID), null);
});
