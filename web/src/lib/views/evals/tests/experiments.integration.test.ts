import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalJudge } from "@/lib/contracts/eval-judge";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { SandboxRun, SandboxVersionSummary, StartRunResult } from "@/lib/views/sandboxes";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { createDrizzleJudgeBudget } from "../adapters/drizzle-judge-budget";
import type { CaseContent, CaseScorer } from "../domain/case";
import { countTrials, unscored } from "../domain/experiment";
import {
  advanceExperiment,
  CLAIM_STOPPED_MS,
  type ExperimentDeps,
  MAX_RUNNING_EXPERIMENTS,
  OPEN_TRIALS,
  startExperiment,
} from "../experiments";
import {
  type ConsoleDeps,
  handleGetByKey,
  handleListByKey,
  handleStartByKey,
  handleStartByMember,
  type KeyDeps,
} from "../experiments-api";
import { content, createEvalsDb, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const COMMIT = "b".repeat(40);
const VERSION: SandboxVersionSummary = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId: PROJECT_ID,
  sandboxId: "77777777-7777-4777-8777-777777777777",
  name: "support-demo",
  git: { commit: COMMIT, dirty: false },
  status: "ready",
  createdAt: new Date(),
  tools: [],
};
const JUDGE: CaseScorer = {
  id: "judge",
  name: "Polite",
  gating: false,
  definition: { kind: "judge", config: { prompt: "Is it polite?", output: "boolean" } },
};

type Started = {
  versionId: string;
  input: unknown;
  options: { params?: object; fixtures?: object };
};

async function setup() {
  const { db, client } = await createEvalsDb();
  const cases = createDrizzleCaseStore(db);
  const experiments = createDrizzleExperimentStore(db);
  const runs = new Map<string, SandboxRun>();
  const started: Started[] = [];
  let versions = [VERSION];
  let refuse: ((n: number) => Exclude<StartRunResult, { ok: true }> | null) | null = null;
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const judge: EvalJudge = {
    provider: "openai",
    model: "m",
    payer: "ratel",
    usdPerInputToken: 0.001,
    ask: async ({ options }) => ({
      answer: { choice: options[0]?.id ?? "", confidence: 0.9 },
      inputTokens: 10,
    }),
  };
  const deps: ExperimentDeps = {
    cases,
    experiments,
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => versions,
      getVersion: async (projectId, id) =>
        versions.find((version) => version.id === id && version.projectId === projectId) ?? null,
      startRun: async (versionId, input, options) => {
        const no = refuse?.(started.length) ?? null;
        started.push({ versionId, input, options });
        if (no) return no;
        const id = crypto.randomUUID();
        const run = {
          id,
          projectId: options.projectId,
          versionId,
          status: "running",
          result: null,
          reason: null,
          traceId: null,
        } as unknown as SandboxRun;
        runs.set(id, run);
        return { ok: true, run };
      },
      getRun: async (projectId, id) => {
        const run = runs.get(id);
        return run?.projectId === projectId ? run : null;
      },
    },
    judge: {
      judge: { judgeFor: async () => judge },
      limits: { dailyBudgetUsd: async () => 100 },
      budget: createDrizzleJudgeBudget(db),
      recordModelCall: () => {},
      now: () => new Date(clock),
    },
    now: () => new Date(clock),
  };
  const approvedCase = async (name: string, over: Partial<CaseContent> = {}) => {
    const made = await cases.create({
      projectId: PROJECT_ID,
      name,
      labels: [],
      content: content(over),
      createdBy: "user_1",
    });
    const [draft] = made.versions;
    assert.ok(draft);
    const { id: versionId, updatedAt } = draft;
    await cases.approve(
      PROJECT_ID,
      made.id,
      { versionId, updatedAt },
      { userId: "user_1", now: new Date() },
    );
    return made;
  };
  const start = async (over: Partial<Parameters<typeof startExperiment>[1]> = {}) => {
    const result = await startExperiment(
      SUBJECT,
      { sandboxVersion: "latest", trialsPerCase: 3, params: {}, startedBy: "user_1", ...over },
      deps,
    );
    assert.ok(result.ok, JSON.stringify(result));
    return result.experiment;
  };
  const end = (run: SandboxRun, over: Partial<SandboxRun> = {}, output: unknown = "No.") =>
    Object.assign(run, {
      status: "completed",
      traceId: "c".repeat(32),
      result: {
        v: 1,
        runId: run.id,
        status: "completed",
        output,
        toolCalls: [],
        usage: { durationMs: 900, costUsd: 0.01 },
        traceId: "c".repeat(32),
      },
      ...over,
    });
  return {
    client,
    cases,
    deps,
    runs,
    started,
    approvedCase,
    start,
    end,
    trials: experiments.trials,
    step: (experiment: Awaited<ReturnType<typeof start>>) => advanceExperiment(experiment, deps),
    setVersions: (next: SandboxVersionSummary[]) => {
      versions = next;
    },
    setRefuse: (next: typeof refuse) => {
      refuse = next;
    },
    pass: (ms: number) => {
      clock += ms;
    },
    table: async (name: string) =>
      (await client.query<Record<string, unknown>>(`select * from ${name} order by id`)).rows,
  };
}

test("two approved cases make 6 trials and 6 sandbox runs, each in a new instance", async () => {
  const t = await setup();
  const fixtures = [{ tool: "refund_order", arguments: { a: 1 }, result: { ok: true } }];
  await t.approvedCase("one", { toolFixtures: fixtures });
  await t.approvedCase("two", { earlierTurns: [{ role: "user", text: "hi" }] });
  await t.cases.create({
    projectId: PROJECT_ID,
    name: "only a draft",
    labels: [],
    content: content(),
    createdBy: "u",
  });
  const experiment = await t.start({ params: { model: "x" } });
  assert.deepEqual(experiment.caseVersions.map(({ name }) => name).sort(), ["one", "two"]);
  assert.deepEqual(await t.step(experiment), { started: 6, finished: 0, closed: false });
  const trials = await t.trials(experiment.id);
  assert.equal(trials.length, 6);
  assert.deepEqual(
    trials.map(({ index }) => index),
    [0, 1, 2, 0, 1, 2],
  );
  assert.equal(new Set(trials.map(({ sandboxRunId }) => sandboxRunId)).size, 6);
  assert.equal(t.runs.size, 6);
  const one = t.started.filter(({ options }) => options.fixtures?.toString() !== "");
  assert.equal(one.length, 3);
  assert.deepEqual(one[0]?.options.fixtures, fixtures);
  assert.deepEqual(one[0]?.options.params, { model: "x" });
  assert.deepEqual(one[0]?.input, { message: "refund A200" });
  assert.ok(
    t.started.some(
      ({ options }) =>
        JSON.stringify(options.params) ===
        JSON.stringify({ model: "x", earlierTurns: [{ role: "user", text: "hi" }] }),
    ),
  );
});

test("the experiment records the version, the commit, the params, the cases and the scorers", async () => {
  const t = await setup();
  const made = await t.approvedCase("one", { scorers: [...content().scorers, JUDGE] });
  const experiment = await t.start({ params: { model: "x" } });
  const versionId = made.versions[0]?.id ?? "";
  assert.equal(experiment.sandboxVersionId, VERSION.id);
  assert.equal(experiment.gitCommit, COMMIT);
  assert.deepEqual(experiment.params, { model: "x" });
  assert.deepEqual(experiment.caseVersions, [
    { caseId: made.id, versionId, number: 1, name: "one" },
  ]);
  const snapshots = experiment.scorerSnapshots[versionId] ?? [];
  assert.deepEqual(
    snapshots.map(({ id, gating }) => [id, gating]),
    [
      ["no-refund", true],
      ["judge", false],
    ],
  );
  for (const { hash } of snapshots) assert.match(hash, /^[0-9a-f]{64}$/);
});

test("the results: pass with an advisory judge, fail of a check, fail of the agent, invalid", async () => {
  const t = await setup();
  await t.approvedCase("one", { scorers: [...content().scorers, JUDGE] });
  const experiment = await t.start({ trialsPerCase: 5 });
  await t.step(experiment);
  const trials = await t.trials(experiment.id);
  const [a, b, c, d, e] = trials.map(({ sandboxRunId }) => t.runs.get(sandboxRunId ?? ""));
  assert.ok(a && b && c && d && e);
  t.end(a);
  t.end(b);
  b.result?.toolCalls.push({ name: "refund_order", arguments: {}, source: "fake" });
  t.end(c, { status: "failed" });
  Object.assign(c.result ?? {}, { status: "failed", error: { type: "Error", message: "boom" } });
  Object.assign(d, { status: "infra_error", reason: "The instance did not start." });
  Object.assign(e, { status: "timed_out", reason: "The run had no result before its timeout." });
  assert.deepEqual(await t.step(experiment), { started: 0, finished: 5, closed: true });

  const done = await t.trials(experiment.id);
  assert.deepEqual(
    done.map(({ result }) => result),
    ["pass", "fail", "fail", "invalid", "invalid"],
  );
  assert.deepEqual(
    done[0]?.scorers.map(({ scorerId, status }) => [scorerId, status]),
    [
      ["no-refund", "pass"],
      ["judge", "pass"],
    ],
  );
  assert.match(done[0]?.scorers[1]?.reason ?? "", /^Yes, with a confidence of 90%/);
  assert.deepEqual(
    [done[0]?.costUsd, done[0]?.durationMs, done[0]?.traceId],
    [0.01, 900, "c".repeat(32)],
  );
  const evidence = await t.deps.experiments.trialEvidence(PROJECT_ID, done[0]?.id ?? "");
  assert.equal(evidence?.output, "No.");
  assert.equal(done[2]?.reason, "Error: boom");
  assert.match(done[3]?.reason ?? "", /^infra_error: /);
  assert.match(done[4]?.reason ?? "", /^timed_out: /);
  const stored = await t.deps.experiments.get(PROJECT_ID, experiment.id);
  assert.deepEqual([stored?.state, stored?.finishedAt !== null], ["completed", true]);
});

test("the row and its frozen lists do not change after the start", async () => {
  const t = await setup();
  const made = await t.approvedCase("one");
  const experiment = await t.start();
  const [before] = await t.table("eval_experiments");
  await t.cases.saveDraft(
    PROJECT_ID,
    made.id,
    { name: "renamed", labels: ["x"], content: content({ scorers: [JUDGE] }) },
    {
      versionId: made.versions[0]?.id ?? "",
      updatedAt: made.versions[0]?.updatedAt ?? new Date(),
    },
    new Date(),
  );
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run);
  await t.step(experiment);
  const [after] = await t.table("eval_experiments");
  const fixed = ({ state: _, finished_at: __, ...rest }: Record<string, unknown>) => rest;
  assert.deepEqual(fixed(after ?? {}), fixed(before ?? {}));
  const trials = await t.table("eval_trials");
  assert.deepEqual((await t.trials(experiment.id))[0]?.scorers[0]?.scorerId, "no-refund");

  // A late step, and a second finish, change nothing. A new run is a new experiment.
  await t.step(experiment);
  for (const { id } of await t.trials(experiment.id)) {
    await t.deps.experiments.finish(id, {
      result: "fail",
      reason: "late",
      output: 1,
      toolCalls: [],
      scorers: [],
      costUsd: 1,
      durationMs: 1,
      traceId: null,
    });
  }
  assert.deepEqual(await t.table("eval_trials"), trials);
  assert.notEqual((await t.start()).id, experiment.id);
  assert.deepEqual(
    await t.deps.experiments.get(PROJECT_ID, experiment.id).then((e) => e?.state),
    "completed",
  );
});

test("no route changes an experiment", () => {
  const api = fileURLToPath(new URL("../../../../app/api", import.meta.url));
  const methods = ["v1/evals/experiments", "projects/[projectId]/evals/experiments"].flatMap(
    (folder) =>
      readdirSync(join(api, folder), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith("route.ts"))
        .flatMap((file) => {
          const text = readFileSync(join(api, folder, file), "utf8");
          return [...text.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)/g)].map(
            ([, method]) => `${method} ${folder}/${file}`,
          );
        }),
  );
  assert.deepEqual(methods.sort(), [
    "GET projects/[projectId]/evals/experiments/[experimentId]/comparison/route.ts",
    "GET projects/[projectId]/evals/experiments/trials/[trialId]/route.ts",
    "GET v1/evals/experiments/[experimentId]/comparison/route.ts",
    "GET v1/evals/experiments/[experimentId]/route.ts",
    "GET v1/evals/experiments/route.ts",
    "POST projects/[projectId]/evals/experiments/route.ts",
    "POST v1/evals/experiments/route.ts",
  ]);
});

test("a refused start makes the trial invalid with the name of the limit", async () => {
  const t = await setup();
  await t.approvedCase("one");
  t.setRefuse((n) =>
    n === 1
      ? {
          ok: false,
          reason: "limit_reached",
          limit: "sandbox_runs_per_day",
          max: 1,
          current: 1,
          message: "The limit is reached.",
        }
      : null,
  );
  const experiment = await t.start();
  await t.step(experiment);
  const [, refused] = await t.trials(experiment.id);
  assert.equal(refused?.result, "invalid");
  assert.match(refused?.reason ?? "", /sandbox_runs_per_day/);
  assert.equal(countTrials(await t.trials(experiment.id)).open, 2);
});

test("a start that throws, a run that is gone and a claim of an ended process are invalid", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start();
  const [claimed] = await t.deps.experiments.claimStarts(experiment, 1, t.deps.now());
  t.pass(CLAIM_STOPPED_MS + 1000);
  t.setRefuse(() => {
    throw new Error("down");
  });
  await t.step(experiment);
  const trials = await t.trials(experiment.id);
  assert.equal(claimed?.id, trials[0]?.id);
  assert.deepEqual(
    trials.map(({ result, reason }) => [result, reason]),
    [
      ["invalid", "The start was interrupted."],
      ["invalid", "The run did not start."],
      ["invalid", "The run did not start."],
    ],
  );
});

test("a scoring of an ended process starts again, and two steps score a trial one time", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start({ trialsPerCase: 1 });
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run);
  const [trial] = await t.trials(experiment.id);
  assert.ok(trial);
  assert.equal(await t.deps.experiments.claimScoring(trial.id, t.deps.now()), true);
  assert.equal(await t.deps.experiments.claimScoring(trial.id, t.deps.now()), false);
  assert.equal((await t.step(experiment)).finished, 0);
  t.pass(CLAIM_STOPPED_MS + 1000);
  assert.deepEqual(await t.step(experiment), { started: 0, finished: 1, closed: true });
});

test("a large experiment has a limited number of open trials", async () => {
  const t = await setup();
  for (let n = 0; n < 8; n += 1) await t.approvedCase(`case ${n}`);
  const experiment = await t.start();
  assert.equal((await t.step(experiment)).started, OPEN_TRIALS);
  assert.equal((await t.step(experiment)).started, 0);
  for (const run of t.runs.values()) t.end(run);
  assert.deepEqual(await t.step(experiment), { started: 4, finished: 20, closed: false });
  for (const run of t.runs.values()) t.end(run);
  assert.equal((await t.step(experiment)).closed, true);
});

test("two processes start each trial one time", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start();
  await Promise.all([t.step(experiment), t.step(experiment)]);
  assert.equal(t.started.length, 3);
});

test("refusals of a start", async () => {
  const t = await setup();
  const start = (sandboxVersion = "latest", trialsPerCase = 3) =>
    startExperiment(
      SUBJECT,
      { sandboxVersion, trialsPerCase, params: {}, startedBy: "u" },
      t.deps,
    ).then((result) => (result.ok ? "ok" : result.reason));
  assert.equal(await start(), "no_cases");
  await t.approvedCase("one");
  assert.equal(await start(OTHER_PROJECT_ID), "not_found");
  t.setVersions([{ ...VERSION, status: "building" }]);
  assert.equal(await start(), "not_ready");
  assert.equal(await start(VERSION.id), "not_ready");
  t.setVersions([{ ...VERSION, id: OTHER_PROJECT_ID, status: "failed" }, VERSION]);
  assert.equal(await start(), "ok");
  t.deps.sandboxes.enabled = async () => false;
  assert.equal(await start(), "sandboxes_off");
});

const request = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });

function keyDeps(t: Awaited<ReturnType<typeof setup>>, over: Partial<KeyDeps> = {}): KeyDeps {
  return {
    experiments: () => t.deps,
    advance: () => {},
    track: async () => {},
    publicUrl: (path) => `https://ratel.test${path}`,
    offForAll: () => false,
    authenticate: async () =>
      ({ ok: true, projectId: PROJECT_ID, apiKeyId: "k1" }) as Awaited<
        ReturnType<KeyDeps["authenticate"]>
      >,
    enabled: async () => true,
    organizationIdOf: async () => ORGANIZATION_ID,
    ...over,
  };
}

test("a key starts an experiment and reads the counts, with no captured text", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const advanced: string[] = [];
  const deps = keyDeps(t, { advance: ({ id }) => void advanced.push(id) });
  const response = await handleStartByKey(request({ sandboxVersion: "latest", trials: 2 }), deps);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(
    body.url,
    `https://ratel.test/project/${PROJECT_ID}/evals/experiments/${body.experimentId}`,
  );
  assert.deepEqual(advanced, [body.experimentId]);
  const experiment = await t.deps.experiments.get(PROJECT_ID, body.experimentId);
  assert.ok(experiment);
  assert.equal(experiment.startedBy, "key:k1");
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run, {}, "captured answer");
  await t.step(experiment);
  const read = await handleGetByKey(body.experimentId, deps);
  const text = await read.text();
  const view = JSON.parse(text);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.counts, { pass: 2, fail: 0, invalid: 0, open: 0 });
  assert.deepEqual(view.cases[0].counts, { pass: 2, fail: 0, invalid: 0, open: 0 });
  assert.equal(view.cases[0].trials.length, 2);
  assert.ok(!text.includes("captured answer"));
  const list = await (await handleListByKey(deps)).json();
  assert.equal(list.experiments[0].experimentId, body.experimentId);
});

test("a wrong body is refused, and a refusal has its reason", async () => {
  const t = await setup();
  const deps = keyDeps(t);
  for (const body of [null, {}, { sandboxVersion: "x" }, { sandboxVersion: "latest", trials: 0 }]) {
    assert.equal((await handleStartByKey(request(body), deps)).status, 400);
  }
  const response = await handleStartByKey(request({ sandboxVersion: "latest" }), deps);
  assert.deepEqual([response.status, (await response.json()).error], [409, "no_cases"]);
});

/** The real key check over fake keys. */
function authenticate(scope: ApiKeyScope, key: { projectId: string; scopes: string[] }) {
  return () =>
    resolveProjectFromBearer(
      new Request("http://x", { headers: { authorization: "Bearer rtl_key" } }),
      scope,
      {
        isDbConfigured: () => true,
        hashApiKey: (plaintext) => plaintext,
        findActiveApiKeyByHash: async () => ({
          id: "99999999-9999-4999-8999-999999999999",
          keyPrefix: "rtl",
          rateLimitPerMinute: null,
          ...key,
        }),
        touchApiKey: async () => {},
      },
    );
}

test("a key with no scope gets 403, and a key of another project gets no data", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start();
  const START = BEARER_ROUTE_SCOPES["POST /api/v1/evals/experiments"];
  const READ = BEARER_ROUTE_SCOPES["GET /api/v1/evals/experiments/[experimentId]"];
  const post = (scopes: string[]) =>
    handleStartByKey(
      request({ sandboxVersion: "latest" }),
      keyDeps(t, { authenticate: authenticate(START, { projectId: PROJECT_ID, scopes }) }),
    );
  const read = (scopes: string[], projectId = PROJECT_ID) =>
    handleGetByKey(
      experiment.id,
      keyDeps(t, { authenticate: authenticate(READ, { projectId, scopes }) }),
    );
  assert.equal((await post(["evals:read", "sandboxes:write"])).status, 403);
  assert.equal((await post(["evals:write"])).status, 201);
  assert.equal((await read(["evals:write"])).status, 403);
  assert.equal((await read(["evals:read"])).status, 200);
  assert.equal((await read(["*"], OTHER_PROJECT_ID)).status, 404);
  const other = authenticate(READ, { projectId: OTHER_PROJECT_ID, scopes: ["*"] });
  const list = await handleListByKey(keyDeps(t, { authenticate: other }));
  assert.deepEqual((await list.json()).experiments, []);
  assert.equal((await handleGetByKey("nope", keyDeps(t))).status, 404);
});

test("with the flag off the routes answer 404", async () => {
  const t = await setup();
  for (const off of [{ offForAll: () => true }, { enabled: async () => false }]) {
    const deps = keyDeps(t, off);
    assert.equal((await handleStartByKey(request({}), deps)).status, 404);
    assert.equal((await handleGetByKey(VERSION.id, deps)).status, 404);
    assert.equal((await handleListByKey(deps)).status, 404);
  }
});

test("a member starts an experiment, and a support session cannot", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const deps = (over: Partial<ConsoleDeps> = {}): ConsoleDeps => ({
    ...keyDeps(t),
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
  const post = (d: ConsoleDeps) =>
    handleStartByMember(request({ sandboxVersion: VERSION.id }), PROJECT_ID, d);
  const response = await post(deps());
  assert.equal(response.status, 201);
  const { experimentId } = await response.json();
  const experiment = await t.deps.experiments.get(PROJECT_ID, experimentId);
  assert.deepEqual([experiment?.startedBy, experiment?.trialsPerCase], ["user_1", 3]);
  assert.equal((await post(deps({ isRestricted: async () => true }))).status, 403);
  assert.equal((await post(deps({ enabled: async () => false }))).status, 404);
  assert.equal((await t.table("eval_experiments")).length, 1);
});

test("the drain gives each project a turn, and a project has a limit of running experiments", async () => {
  const t = await setup();
  await t.approvedCase("one");
  for (let n = 0; n < MAX_RUNNING_EXPERIMENTS; n += 1) await t.start({ trialsPerCase: 1 });
  const more = await startExperiment(
    SUBJECT,
    { sandboxVersion: "latest", trialsPerCase: 1, params: {}, startedBy: "u" },
    t.deps,
  );
  assert.ok(!more.ok && more.reason === "too_many_running");
  const seen = new Set<string>();
  for (let n = 0; n < 60; n += 1) {
    const page = await t.deps.experiments.listRunning(2);
    for (const { id } of page) seen.add(id);
  }
  assert.equal(seen.size, MAX_RUNNING_EXPERIMENTS, "no experiment waits for an older one");
});

test("with the sandboxes flag off no trial starts", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start();
  t.deps.sandboxes.enabled = async () => false;
  assert.equal((await t.step(experiment)).started, 0);
  assert.equal(t.started.length, 0);
  t.deps.sandboxes.enabled = async () => true;
  assert.equal((await t.step(experiment)).started, 3);
});

test("a step ends at its deadline, and the next one goes on", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start({ trialsPerCase: 10 });
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run);
  const past = new Date(t.deps.now().getTime() - 1);
  const late = await advanceExperiment(experiment, t.deps, past);
  assert.deepEqual([late.finished, late.closed], [0, false]);
  assert.deepEqual([(await t.step(experiment)).finished], [10]);
});

test("the judges of a trial run at the same time", async () => {
  const t = await setup();
  const judges = [1, 2, 3].map((n) => ({ ...JUDGE, id: `j${n}` }));
  await t.approvedCase("one", { scorers: [...content().scorers, ...judges] });
  const experiment = await t.start({ trialsPerCase: 1 });
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run);
  let open = 0;
  let most = 0;
  const judge = await t.deps.judge.judge.judgeFor(SUBJECT);
  assert.ok(judge);
  t.deps.judge.judge = {
    judgeFor: async () => ({
      ...judge,
      ask: async (request) => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((done) => setTimeout(done, 20));
        open -= 1;
        return judge.ask(request);
      },
    }),
  };
  await t.step(experiment);
  assert.equal(most, 3);
});

test("the experiments of a project share the open trials", async () => {
  const t = await setup();
  for (let n = 0; n < 5; n += 1) await t.approvedCase(`case ${n}`);
  const first = await t.start();
  const second = await t.start();
  assert.equal((await t.step(first)).started, 15);
  assert.equal((await t.step(second)).started, OPEN_TRIALS - 15);
});

test("the read of a key does not load the outputs", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start();
  await t.step(experiment);
  for (const run of t.runs.values()) t.end(run);
  await t.step(experiment);
  const trials = await t.deps.experiments.trials(experiment.id);
  assert.ok(trials.every((trial) => !("output" in trial) && !("toolCalls" in trial)));
  const [first] = trials;
  assert.ok(first);
  const evidence = await t.deps.experiments.trialEvidence(PROJECT_ID, first.id);
  assert.deepEqual(evidence, { output: "No.", toolCalls: [] });
  assert.equal(await t.deps.experiments.trialEvidence(OTHER_PROJECT_ID, first.id), null);
});

test("a run that started stays linked when the trial did not become running", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start({ trialsPerCase: 1 });
  t.deps.experiments = {
    ...t.deps.experiments,
    markRunning: async () => {
      throw new Error("down");
    },
  };
  await t.step(experiment);
  const [trial] = await t.deps.experiments.trials(experiment.id);
  assert.equal(trial?.result, "invalid");
  assert.equal(trial?.sandboxRunId, [...t.runs.keys()][0]);
});

test("a start that became running is not ended as interrupted", async () => {
  const t = await setup();
  await t.approvedCase("one");
  const experiment = await t.start({ trialsPerCase: 1 });
  const { experiments } = t.deps;
  const [claimed] = await experiments.claimStarts(experiment, 1, t.deps.now());
  assert.ok(claimed);
  await experiments.markRunning(claimed.id, VERSION.id);
  const late = new Date(t.deps.now().getTime() + 1e9);
  const ended = await experiments.endStoppedStarts(experiment.id, late, {
    ...unscored("invalid", "The start was interrupted."),
  });
  assert.equal(ended, 0);
  assert.equal((await experiments.trials(experiment.id))[0]?.state, "running");
});
