import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleBuildStore } from "@/lib/views/sandboxes/adapters/drizzle-build-store";
import { createDrizzleRunStore } from "@/lib/views/sandboxes/adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "@/lib/views/sandboxes/adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "@/lib/views/sandboxes/adapters/drizzle-version-store";
import { createDrizzleVmStore } from "@/lib/views/sandboxes/adapters/drizzle-vm-store";
import {
  ProviderAtCapacity,
  type SandboxProvider,
} from "@/lib/views/sandboxes/ports/sandbox-provider";
import { getRun, type RunDeps, startRun } from "@/lib/views/sandboxes/runs";
import { type AgentScript, scriptAgent } from "@/lib/views/sandboxes/tests/fake-agent";
import { createFakeProvider } from "@/lib/views/sandboxes/tests/fake-provider";
import { bundleInfo, COMMIT, IMAGE, tarGz } from "@/lib/views/sandboxes/tests/support";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { createDrizzleJudgeBudget } from "../adapters/drizzle-judge-budget";
import { advanceExperiment, type ExperimentDeps, startExperiment } from "../experiments";
import { content, createEvalsDb, ORGANIZATION_ID, PROJECT_ID } from "./support";

/**
 * An eval trial through the real runs of Ratel sandboxes (a fake provider): the evals engine reads
 * the result of `getRun` as it did before warm VMs.
 */

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };

async function setup(agent: AgentScript = {}) {
  const { db } = await createEvalsDb();
  const versions = createDrizzleVersionStore(db);
  const created = await versions.create(
    {
      projectId: PROJECT_ID,
      apiKeyId: null,
      config: { name: "support-demo", input: { example: "hi" }, tools: { refund_order: {} } },
      image: IMAGE,
      git: { commit: COMMIT, dirty: false },
      bundle: bundleInfo(tarGz([{ name: "a", body: "x" }])),
    },
    async () => ({ ok: true }),
  );
  assert.ok(created.ok);
  const { version } = created;
  const builds = createDrizzleBuildStore(db);
  await versions.markUploaded(PROJECT_ID, version.id);
  await builds.claim(PROJECT_ID, version.id, new Date());
  const provider = createFakeProvider();
  provider.snapshots.set(`rv-${version.id}`, new Map());
  scriptAgent(provider, agent);
  const smoke = { ok: true as const, output: 1, durationMs: 1, logs: "" };
  const imageRef = `rv-${version.id}`;
  await builds.finish(version.id, { status: "ready", imageRef, smoke, log: "" }, new Date());

  const pending: Array<Promise<void>> = [];
  const runDeps = (more: Partial<RunDeps> = {}): RunDeps => ({
    runs: createDrizzleRunStore(db),
    vms: createDrizzleVmStore(db),
    versions,
    secrets: createDrizzleSecretStore(db),
    provider,
    limits: createInMemoryUsageLimits(),
    sealingKey: () => ({ ok: true, key: Buffer.alloc(32, 1) }),
    callbackUrl: () => "https://ratel.example",
    now: () => new Date(),
    background: (work) => {
      pending.push(work());
    },
    ...more,
  });
  const summary: SandboxVersionSummary = {
    id: version.id,
    projectId: PROJECT_ID,
    sandboxId: version.sandboxId,
    name: version.name,
    git: version.git,
    status: "ready",
    createdAt: version.createdAt,
    tools: [{ name: "refund_order", sideEffect: true }],
    params: [],
  };
  const cases = createDrizzleCaseStore(db);
  const experiments = createDrizzleExperimentStore(db);
  const deps = (more: Partial<RunDeps> = {}): ExperimentDeps => ({
    cases,
    experiments,
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [summary],
      getVersion: async () => summary,
      startRun: (versionId, input, options) => startRun(versionId, input, options, runDeps(more)),
      getRun: (projectId, runId) => getRun(projectId, runId, runDeps(more)),
    },
    judge: {
      judge: { judgeFor: async () => null },
      limits: { dailyBudgetUsd: async () => 0 },
      budget: createDrizzleJudgeBudget(db),
      recordModelCall: () => {},
      now: () => new Date(),
    },
    now: () => new Date(),
  });
  /** One trial of one approved case, to its end. */
  const trial = async (more: Partial<RunDeps> = {}) => {
    const made = await cases.create({
      projectId: PROJECT_ID,
      name: "refund",
      labels: [],
      content: content(),
      createdBy: "user_1",
    });
    const [draft] = made.versions;
    assert.ok(draft);
    await cases.approve(
      PROJECT_ID,
      made.id,
      { versionId: draft.id, updatedAt: draft.updatedAt },
      { userId: "user_1", now: new Date() },
    );
    const started = await startExperiment(
      SUBJECT,
      { sandboxVersion: "latest", trialsPerCase: 1, params: {}, startedBy: "user_1" },
      deps(more),
    );
    assert.ok(started.ok, JSON.stringify(started));
    assert.equal((await advanceExperiment(started.experiment, deps(more))).started, 1);
    for (let work = pending.shift(); work; work = pending.shift()) await work;
    assert.equal((await advanceExperiment(started.experiment, deps(more))).finished, 1);
    const [one] = await experiments.trials(started.experiment.id);
    assert.ok(one);
    return one;
  };
  return { trial };
}

test("an eval trial through a sandbox run passes, and a refund that the case forbids fails it", async () => {
  const passed = await setup();
  const ok = await passed.trial();
  assert.equal(ok.result, "pass", ok.reason ?? "");
  assert.match(ok.traceId ?? "", /^[0-9a-f]{32}$/);

  const refund = {
    output: "refunded",
    toolCalls: [{ name: "refund_order", args: { id: "A200" }, mode: "simulated", result: true }],
  };
  const failed = await setup({ answer: { status: 200, body: JSON.stringify(refund) } });
  const bad = await failed.trial();
  assert.equal(bad.result, "fail");
});

test("a failure of the infrastructure gives an invalid trial, not a failed one", async () => {
  const t = await setup();
  const broken = createFakeProvider();
  const provider: SandboxProvider = {
    ...broken,
    startVm: async () => {
      throw new ProviderAtCapacity();
    },
  };
  const trial = await t.trial({ provider });
  assert.equal(trial.result, "invalid");
  assert.match(trial.reason ?? "", /infra_error/);
});

test("an agent that does not answer in time gives an invalid trial", async () => {
  const t = await setup({ answer: { curlExit: 28 } });
  const trial = await t.trial();
  assert.equal(trial.result, "invalid");
  assert.match(trial.reason ?? "", /timed_out/);
});
