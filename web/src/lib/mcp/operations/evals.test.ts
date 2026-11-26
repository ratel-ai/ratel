import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { assembleOperations } from "@/lib/mcp/operations";
import { buildRegistry } from "@/lib/mcp/registry";
import type { CaseVersion, EvalCase } from "@/lib/views/evals/domain/case";
import { VERDICT_RULE } from "@/lib/views/evals/domain/compare";
import type { Experiment, Trial } from "@/lib/views/evals/domain/experiment";
import type { NewCase } from "@/lib/views/evals/ports/case-store";
import type { SandboxRun } from "@/lib/views/sandboxes";
import { type EvalsOperationDeps, evalsOperations } from "./evals";

/**
 * The eval tools, through dispatch with fake module calls: the flag, the project, the refusals of
 * the module with their reasons, and results that show inputs and outputs first.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const CASE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const BASE_RUN = "66666666-6666-4666-8666-666666666666";
const TRIAL = "77777777-7777-4777-8777-777777777777";
const BASE_TRIAL = "88888888-8888-4888-8888-888888888888";
const SANDBOX_RUN = "99999999-9999-4999-8999-999999999999";
const BASE_VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = new Date("2026-11-26T10:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const GATING_CHECK = {
  id: "s1",
  name: "mentions refund",
  gating: true,
  definition: {
    kind: "check" as const,
    config: { path: "output", op: "contains" as const, value: "refund" },
  },
};

function caseVersion(overrides: Partial<CaseVersion> = {}): CaseVersion {
  return {
    id: DRAFT,
    caseId: CASE,
    number: 1,
    state: "draft",
    input: { message: "I want my money back" },
    earlierTurns: [],
    toolFixtures: [],
    expectedOutput: null,
    scorers: [GATING_CHECK],
    sourceTurnId: null,
    sourceOutput: "No.",
    approvedBy: null,
    approvedAt: null,
    updatedAt: T0,
    ...overrides,
  };
}

function evalCase(versions: CaseVersion[] = [caseVersion()]): EvalCase {
  return { id: CASE, projectId: PROJECT, name: "refund ask", labels: [], createdAt: T0, versions };
}

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: RUN,
    projectId: PROJECT,
    organizationId: "org-1",
    sandboxVersionId: "sv-1",
    sandboxName: "support-agent",
    gitCommit: "",
    gitDirty: false,
    params: {},
    trialsPerCase: 1,
    caseVersions: [{ caseId: CASE, versionId: DRAFT, number: 1, name: "refund ask" }],
    scorerSnapshots: { [DRAFT]: [{ ...GATING_CHECK, hash: "h1" }] },
    startedBy: "mcp:key:key-1",
    state: "completed",
    createdAt: T0,
    finishedAt: T0,
    ...overrides,
  };
}

function trial(overrides: Partial<Trial> = {}): Trial {
  return {
    id: TRIAL,
    experimentId: RUN,
    caseVersionId: DRAFT,
    index: 0,
    state: "done",
    result: "pass",
    reason: null,
    scorers: [
      {
        scorerId: "s1",
        name: "mentions refund",
        kind: "check",
        gating: true,
        status: "pass",
        reason: "output contains refund",
      },
    ],
    costUsd: null,
    durationMs: 900,
    traceId: null,
    sandboxRunId: SANDBOX_RUN,
    ...overrides,
  };
}

const baseline = experiment({
  id: BASE_RUN,
  caseVersions: [{ caseId: CASE, versionId: BASE_VERSION, number: 1, name: "refund ask" }],
  scorerSnapshots: { [BASE_VERSION]: [{ ...GATING_CHECK, hash: "h1" }] },
});
const baselineTrial = trial({
  id: BASE_TRIAL,
  experimentId: BASE_RUN,
  caseVersionId: BASE_VERSION,
  result: "fail",
});

function sandboxRun(overrides: Partial<SandboxRun> = {}): SandboxRun {
  return {
    id: SANDBOX_RUN,
    projectId: PROJECT,
    versionId: "sv-1",
    request: {
      v: 1,
      runId: SANDBOX_RUN,
      input: { message: "refund?" },
      params: {},
      tools: {},
      fixtures: [],
    },
    status: "completed",
    response: null,
    errorCode: null,
    reason: null,
    logs: null,
    durationMs: 10,
    result: {
      v: 1,
      runId: SANDBOX_RUN,
      status: "completed",
      output: { reply: "No." },
      toolCalls: [],
      usage: { durationMs: 10 },
      traceId: "",
    },
    traceId: null,
    vmId: null,
    instanceRef: null,
    timeoutS: 60,
    requestedBy: "x",
    createdAt: T0,
    startedAt: T0,
    finishedAt: T0,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<EvalsOperationDeps> = {}): EvalsOperationDeps {
  const experiments = [experiment(), baseline];
  return {
    enabled: async () => true,
    listCases: async () => [evalCase()],
    getCase: async (projectId, id) => (projectId === PROJECT && id === CASE ? evalCase() : null),
    createCase: async (input) => ({
      id: CASE,
      projectId: input.projectId,
      name: input.name,
      labels: input.labels,
      createdAt: T0,
      versions: [caseVersion({ ...input.content, sourceOutput: input.source?.output ?? null })],
    }),
    approveCase: async () => "approved",
    startExperiment: async () => ({
      ok: true,
      experiment: experiment({ state: "running", finishedAt: null }),
    }),
    advance: () => {},
    listExperiments: async () => experiments,
    getExperiment: async (projectId, id) =>
      projectId === PROJECT ? (experiments.find((one) => one.id === id) ?? null) : null,
    trials: async (id) => (id === RUN ? [trial()] : id === BASE_RUN ? [baselineTrial] : []),
    trialEvidence: async (_projectId, id) => ({
      output: id === TRIAL ? { reply: "Here is your refund." } : { reply: "No." },
      toolCalls: [],
    }),
    caseVersion: async (id) => (id === DRAFT ? caseVersion() : null),
    getBaseline: async () => ({ experimentId: BASE_RUN, pinnedBy: "x", pinnedAt: T0 }),
    pinBaseline: async (_projectId, experimentId, pinnedBy) => ({
      ok: true,
      baseline: { experimentId, pinnedBy, pinnedAt: T0 },
    }),
    compareWithBaseline: async () => ({
      ok: true,
      pin: { experimentId: BASE_RUN, pinnedBy: "x", pinnedAt: T0 },
      baseline: { experiment: baseline, trials: [baselineTrial] },
      candidate: { experiment: experiment(), trials: [trial()] },
      comparison: {
        ok: true,
        verdict: "improved",
        rule: VERDICT_RULE.improved,
        cases: [
          {
            caseId: CASE,
            name: "refund ask",
            change: "improved",
            baseline: {
              versionId: BASE_VERSION,
              number: 1,
              status: "fail",
              counts: { pass: 0, fail: 1, invalid: 0, open: 0 },
            },
            candidate: {
              versionId: DRAFT,
              number: 1,
              status: "pass",
              counts: { pass: 1, fail: 0, invalid: 0, open: 0 },
            },
          },
        ],
      },
    }),
    getSandboxRun: async (projectId, id) =>
      projectId === PROJECT && id === SANDBOX_RUN ? sandboxRun() : null,
    mayReadContent: async () => true,
    organizationIdOf: async () => "org-1",
    now: () => T0,
    sleep: async () => {},
    ...overrides,
  };
}

function call(
  id: string,
  params: Record<string, unknown>,
  overrides: Partial<EvalsOperationDeps> = {},
) {
  return dispatchOperation(id, params, {
    registry: buildRegistry(evalsOperations(fakeDeps(overrides))),
    auth,
  });
}

function ok<Data>(result: Awaited<ReturnType<typeof call>>): DispatchSuccess & { data: Data } {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as DispatchSuccess & { data: Data };
}

function failure(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: false }>;
}

const PARAMS: Record<string, Record<string, unknown>> = {
  evals_list_cases: {},
  evals_get_case: { caseId: CASE },
  evals_create_case: { name: "x", input: "hi" },
  evals_approve_case: { caseId: CASE },
  evals_start_run: {},
  evals_list_runs: {},
  evals_get_run: { runId: RUN },
  evals_get_trial: { runId: RUN, trialId: TRIAL },
  evals_compare: { runId: RUN },
  evals_pin_baseline: { runId: RUN },
};
const IDS = Object.keys(PARAMS);

// — Listing, flag and scope ————————————————————————————————————————————————————

test("evals: the tools are listed only when the flag is on for the caller", () => {
  const on = assembleOperations({ evals: true }).map((operation) => operation.id);
  const off = assembleOperations({ evals: false }).map((operation) => operation.id);
  for (const id of IDS) {
    assert.ok(on.includes(id), `${id} is listed with the flag on`);
    assert.ok(!off.includes(id), `${id} is not listed with the flag off`);
  }
});

test("evals: create, approve, start and pin mutate; the rest only read", () => {
  const mutating = evalsOperations(fakeDeps())
    .filter((operation) => operation.mutates)
    .map((operation) => operation.id);
  assert.deepEqual(mutating, [
    "evals_create_case",
    "evals_approve_case",
    "evals_start_run",
    "evals_pin_baseline",
  ]);
});

for (const id of IDS) {
  test(`evals: ${id} refuses a project with the flag off`, async () => {
    const result = failure(await call(id, PARAMS[id] ?? {}, { enabled: async () => false }));
    assert.equal(result.error, "forbidden");
    assert.equal(result.reason, "evals_off");
  });

  test(`evals: ${id} refuses another project than the one of the key`, async () => {
    const result = failure(await call(id, { ...PARAMS[id], projectId: OTHER_PROJECT }));
    assert.equal(result.error, "forbidden");
  });
}

// — Cases ——————————————————————————————————————————————————————————————————————

test("evals_list_cases: says which cases are approved, and hints when none is", async () => {
  const result = ok<{
    cases: Array<{ approvedVersion: number | null; draftVersion: number | null }>;
    approved: number;
  }>(await call("evals_list_cases", {}));
  assert.equal(result.data.approved, 0);
  assert.deepEqual(result.data.cases[0], {
    caseId: CASE,
    name: "refund ask",
    labels: [],
    approvedVersion: null,
    draftVersion: 1,
    createdAt: T0.toISOString(),
  });
  assert.match(result.hint ?? "", /evals_approve_case/);
});

test("evals_create_case: copies the input and the answer of a sandbox run", async () => {
  let saved: NewCase | undefined;
  const result = ok<{ caseId: string; state: string }>(
    await call(
      "evals_create_case",
      {
        name: "refund ask",
        sandboxRunId: SANDBOX_RUN,
        scorers: [
          {
            kind: "check",
            name: "mentions refund",
            path: "output",
            op: "contains",
            value: "refund",
          },
        ],
      },
      {
        createCase: async (input) => {
          saved = input;
          return fakeDeps().createCase(input);
        },
      },
    ),
  );
  assert.equal(result.data.state, "draft");
  assert.deepEqual(saved?.content.input, { message: "refund?" });
  assert.deepEqual(saved?.source, { turnId: null, output: '{"reply":"No."}' });
  assert.equal(saved?.content.scorers[0]?.gating, true);
  assert.equal(saved?.content.scorers[0]?.definition.kind, "check");
  assert.equal(saved?.createdBy, "mcp:key:key-1");
  assert.match(result.hint ?? "", /evals_approve_case/);
});

test("evals_create_case: a sandbox run of another project is not_found", async () => {
  const result = failure(
    await call(
      "evals_create_case",
      { name: "x", sandboxRunId: SANDBOX_RUN },
      { getSandboxRun: async () => null },
    ),
  );
  assert.equal(result.error, "not_found");
});

test("evals_create_case: a run that has not ended is refused", async () => {
  const result = failure(
    await call(
      "evals_create_case",
      { name: "x", sandboxRunId: SANDBOX_RUN },
      { getSandboxRun: async () => sandboxRun({ status: "running", result: null }) },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "run_active");
});

test("evals_create_case: a case with no gating scorer is saved and says why it cannot be approved", async () => {
  const result = ok<{ approvalProblem?: string }>(
    await call("evals_create_case", { name: "x", input: "hi" }),
  );
  assert.match(result.data.approvalProblem ?? "", /gating/);
});

test("evals_create_case: a check that reads a path a trial does not have is refused", async () => {
  const result = failure(
    await call("evals_create_case", {
      name: "x",
      input: "hi",
      scorers: [{ kind: "check", name: "c", path: "service", op: "eq", value: "a" }],
    }),
  );
  assert.equal(result.error, "invalid_params");
});

test("evals_approve_case: approves the draft as it was read", async () => {
  let approved: { versionId: string; updatedAt: Date } | undefined;
  const result = ok<{ state: string; version: number }>(
    await call(
      "evals_approve_case",
      { caseId: CASE },
      {
        approveCase: async (_projectId, _caseId, draft) => {
          approved = draft;
          return "approved";
        },
      },
    ),
  );
  assert.deepEqual(approved, { versionId: DRAFT, updatedAt: T0 });
  assert.equal(result.data.state, "approved");
});

test("evals_approve_case: refuses a draft with no gating scorer, with the reason", async () => {
  const result = failure(
    await call(
      "evals_approve_case",
      { caseId: CASE },
      {
        getCase: async () => evalCase([caseVersion({ scorers: [] })]),
      },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "not_ready");
  assert.match(result.message, /gating/);
});

test("evals_get_case: withholds captured text from a key without content access", async () => {
  const result = ok<{ newest: { input: unknown }; contentWithheld?: boolean }>(
    await call("evals_get_case", { caseId: CASE }, { mayReadContent: async () => false }),
  );
  assert.equal(result.data.newest.input, null);
  assert.equal(result.data.contentWithheld, true);
});

// — Eval runs ——————————————————————————————————————————————————————————————————

test("evals_start_run: returns the run id at once and a hint to poll evals_get_run", async () => {
  let advanced = 0;
  const result = ok<{ runId: string; state: string }>(
    await call(
      "evals_start_run",
      { trials: 1 },
      {
        advance: () => {
          advanced += 1;
        },
      },
    ),
  );
  assert.equal(result.data.runId, RUN);
  assert.equal(result.data.state, "running");
  assert.equal(advanced, 1);
  assert.match(result.hint ?? "", /evals_get_run/);
  assert.match(result.hint ?? "", new RegExp(RUN));
});

test("evals_start_run: only approved cases count, and none approved is refused with the reason", async () => {
  const result = failure(
    await call(
      "evals_start_run",
      {},
      {
        startExperiment: async () => ({
          ok: false,
          reason: "no_cases",
          message: "No case is approved. Approve one first.",
        }),
      },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "no_cases");
  assert.match(result.message, /approved/);
});

test("evals_get_run: shows for each case the input, the outputs and the raw counts", async () => {
  const result = ok<{
    state: string;
    counts: { pass: number; fail: number };
    cases: Array<{
      input: unknown;
      counts: { pass: number };
      trials: Array<{ output: unknown; result: string }>;
    }>;
  }>(await call("evals_get_run", { runId: RUN }));
  const [row] = result.data.cases;
  assert.deepEqual(row?.input, { message: "I want my money back" });
  assert.deepEqual(row?.counts, { pass: 1, fail: 0, invalid: 0, open: 0 });
  assert.deepEqual(row?.trials[0]?.output, { reply: "Here is your refund." });
  assert.equal(row?.trials[0]?.result, "pass");
  assert.equal(result.data.counts.pass, 1);
  assert.match(result.hint ?? "", /evals_compare/);
});

test("evals_get_run: waits for a running run to end", async () => {
  let reads = 0;
  const result = ok<{ state: string }>(
    await call(
      "evals_get_run",
      { runId: RUN },
      {
        getExperiment: async () => {
          reads += 1;
          return reads < 3 ? experiment({ state: "running", finishedAt: null }) : experiment();
        },
      },
    ),
  );
  assert.equal(result.data.state, "completed");
  assert.equal(reads, 3);
});

test("evals_get_run: a run still running after the wait hints to call again", async () => {
  let clock = T0.getTime();
  const result = ok<{ state: string }>(
    await call(
      "evals_get_run",
      { runId: RUN },
      {
        getExperiment: async () => experiment({ state: "running", finishedAt: null }),
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
  );
  assert.equal(result.data.state, "running");
  assert.match(result.hint ?? "", /again/);
  assert.ok(
    clock - T0.getTime() <= 30_000,
    "the wait stays well under the 60 second limit of a call",
  );
});

test("evals_get_trial: shows the output and the scorer reasons", async () => {
  const result = ok<{ output: unknown; scorers: Array<{ reason: string | null }> }>(
    await call("evals_get_trial", { runId: RUN, trialId: TRIAL }),
  );
  assert.deepEqual(result.data.output, { reply: "Here is your refund." });
  assert.equal(result.data.scorers[0]?.reason, "output contains refund");
});

test("evals_get_trial: a trial of another run is not_found", async () => {
  const result = failure(await call("evals_get_trial", { runId: BASE_RUN, trialId: TRIAL }));
  assert.equal(result.error, "not_found");
});

// — Comparison and baseline ——————————————————————————————————————————————————

test("evals_compare: gives the verdict, the rule and the changed cases with both outputs", async () => {
  const result = ok<{
    verdict: string;
    rule: string;
    changedCases: Array<{
      change: string;
      baseline: { output: unknown };
      candidate: { output: unknown };
    }>;
  }>(await call("evals_compare", { runId: RUN }));
  assert.equal(result.data.verdict, "improved");
  assert.equal(result.data.rule, VERDICT_RULE.improved);
  const [changed] = result.data.changedCases;
  assert.equal(changed?.change, "improved");
  assert.deepEqual(changed?.baseline.output, { reply: "No." });
  assert.deepEqual(changed?.candidate.output, { reply: "Here is your refund." });
});

test("evals_compare: two runs with different scorers are refused with the reason", async () => {
  const result = failure(
    await call(
      "evals_compare",
      { runId: RUN },
      {
        compareWithBaseline: async () => ({
          ok: false,
          refusal: {
            reason: "scorers_differ",
            message:
              'The scorers of the two experiments differ: "mentions refund" of "refund ask".',
            scorers: [],
            pin: null,
          },
        }),
      },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "scorers_differ");
  assert.match(result.message, /scorers of the two experiments differ/);
});

test("evals_compare: with baselineRunId compares the two runs, and different scorers are refused", async () => {
  const other = experiment({
    id: BASE_RUN,
    caseVersions: [{ caseId: CASE, versionId: BASE_VERSION, number: 1, name: "refund ask" }],
    scorerSnapshots: { [BASE_VERSION]: [{ ...GATING_CHECK, hash: "different" }] },
  });
  const result = failure(
    await call(
      "evals_compare",
      { runId: RUN, baselineRunId: BASE_RUN },
      {
        getExperiment: async (_projectId, id) => (id === RUN ? experiment() : other),
      },
    ),
  );
  assert.equal(result.reason, "scorers_differ");
});

test("evals_compare: with baselineRunId gives a verdict without a pin", async () => {
  const result = ok<{ verdict: string; baselineRunId: string }>(
    await call(
      "evals_compare",
      { runId: RUN, baselineRunId: BASE_RUN },
      { getBaseline: async () => null },
    ),
  );
  assert.equal(result.data.verdict, "improved");
  assert.equal(result.data.baselineRunId, BASE_RUN);
});

test("evals_pin_baseline: a run that has not ended is refused with the reason", async () => {
  const result = failure(
    await call(
      "evals_pin_baseline",
      { runId: RUN },
      {
        pinBaseline: async () => ({
          ok: false,
          reason: "not_completed",
          message: "The experiment has not ended. Pin it when it is completed.",
        }),
      },
    ),
  );
  assert.equal(result.error, "conflict");
  assert.equal(result.reason, "not_completed");
});

test("evals_pin_baseline: pins a completed run", async () => {
  const result = ok<{ baselineRunId: string }>(await call("evals_pin_baseline", { runId: RUN }));
  assert.equal(result.data.baselineRunId, RUN);
});
