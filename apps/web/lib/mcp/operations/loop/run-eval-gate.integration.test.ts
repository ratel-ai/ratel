import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { emptyChange } from "@/lib/views/eval-gate/change";
import {
  EVAL_GATE_OFF_ERROR,
  evalGateEnabledForActor,
  evalGateEnabledForRun,
} from "@/lib/views/eval-gate/gate";
import { simulateFixEvalJob } from "@/lib/views/eval-gate/job";
import type { EvalModels } from "@/lib/views/eval-gate/models";
import { runSimulation } from "@/lib/views/eval-gate/service";
import { createEvalSet, getEvalRun, queueEvalRun } from "@/lib/views/eval-gate/store";
import { fixStats } from "@/lib/views/fixes/select";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { defaultLoopDeps, loopWriteOperations } from "./index";

/**
 * MCP `run_eval` and the `simulate_fix_eval` job under the eval gate, on a
 * real database. Owned (ADR-0030): the gate is one switch, `FF_EVAL_GATE`,
 * so the cases are on and off; upstream's are its per-organization rollout.
 * Nothing here calls a model: the stand-in models count calls and answer
 * nothing.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const INSIGHT = "33333333-3333-4333-8333-333333333333";
const ON = { FF_EVAL_GATE: "1" };
const OFF = {};

type Db = ReturnType<typeof getDb>;
type Env = Record<string, string | undefined>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

/** Models that count every call and answer none. */
function countingModels(): { models: EvalModels; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    models: {
      agent: () => {
        calls += 1;
        return null;
      },
      tool: null,
      judge: null,
      standIn: true,
    },
  };
}

function fixFor(projectId: string): Fix {
  return {
    id: `issue:${INSIGHT}`,
    source: "issue",
    sourceId: INSIGHT,
    aliases: [`issue:${INSIGHT}`],
    title: "Retry hold_fare when it times out",
    short: "Retry a failing tool",
    why: "hold_fare fails in 31% of its calls.",
    // A kind with something to simulate (RC-77): its failures come back as a clear failure.
    kind: "fail-clearly",
    kindLabel: "Fail clearly",
    group: "agent" as Fix["group"],
    status: "open",
    subject: {
      tools: [{ id: "hold_fare", label: "hold_fare", href: "/catalog" }],
      tasks: [],
      topics: [],
    },
    effect: {
      value: "−41 failed calls",
      figure: "−41",
      unit: "failed calls",
      detail: "over 30 days",
      tone: "good",
      basis: "runs",
      also: [],
    },
    gain: null,
    evidence: { strength: "solid", label: "Solid", detail: "Seen 132 times" },
    issues: [
      {
        id: INSIGHT,
        kind: "tool_errors",
        title: "Tool keeps failing",
        claim: "hold_fare fails in 31% of its calls.",
        cost: "41 failed calls",
        figure: null,
        href: `/project/${projectId}/health`,
      },
    ],
    actions: {
      apply: false,
      dismiss: false,
      revert: false,
      catalogHref: null,
      copy: null,
      descriptionHref: null,
    },
    detail: { source: "issue", changes: ["Retry hold_fare with backoff."], caveat: null },
    rank: { tier: 1, score: 0.3, count: 41 },
    appliedAt: null,
  } as Fix;
}

function modelFor(projectId: string): FixesModel {
  return {
    projectId,
    open: [fixFor(projectId)],
    applied: [],
    stats: {
      open: 1,
      ready: 0,
      fromIssues: 1,
      issues: 1,
      tools: 1,
      roundTripsSaved: null,
      savings: fixStats([]).savings,
      evidence: { early: 0, solid: 1, strong: 0, none: 0 },
    },
    failed: [],
    rewritesOn: false,
    overridesAdopted: null,
  };
}

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: ORG, slug: "acme", effectivePlan: "pro" },
};

/** The real `run_eval` over the real eval gate and service, on this database. It queues: the run ids land in `queued`, for the job. */
async function runEval(
  db: Db,
  env: Env,
  models: EvalModels,
  queued: string[] = [],
  fixOf: (projectId: string) => Fix = fixFor,
): Promise<DispatchResult> {
  const deps = {
    ...defaultLoopDeps,
    loadProjectFixes: async (id: string) => ({ ...modelFor(id), open: [fixOf(id)] }),
    loadInsight: async () => null,
    recordLineage: (async (input) => input.object) as typeof defaultLoopDeps.recordLineage,
    evalGateEnabled: (id: string, actor: string) => evalGateEnabledForActor(id, actor, db, env),
    runSimulation: ((fixId, options = {}) =>
      runSimulation(fixId, {
        ...options,
        deps: {
          db,
          models,
          loadFix: async (id) => ({ projectId: id, fix: fixOf(id) }),
          loadCorpus: async () => [],
          enqueue: async (_projectId, runId) => {
            queued.push(runId);
            return null;
          },
        },
      })) as typeof runSimulation,
    trackServerEvent: (async () => {}) as unknown as typeof defaultLoopDeps.trackServerEvent,
  };
  return dispatchOperation(
    "run_eval",
    { fixId: `issue:${INSIGHT}` },
    {
      registry: buildRegistry(loopWriteOperations(deps)),
      auth,
      projectOwner: async () => ({ organizationId: ORG }),
    },
  );
}

async function count(client: PGlite, table: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]!.n;
}

function jobDeps(db: Db, env: Env, models: EvalModels) {
  return {
    gateEnabled: (run: { projectId: string; requestedBy: string | null }) =>
      evalGateEnabledForRun(run, db, env),
    eval: { db, models, loadCorpus: async () => [] },
  };
}

test("with the gate on, run_eval queues the simulation and returns it; again while it runs, the same one; the job completes it", async () => {
  const { client, db } = await setup();
  try {
    const { models } = countingModels();
    const queued: string[] = [];
    const result = await runEval(db, ON, models, queued);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result as { data: { eval: { status: string } } }).data.eval.status, "queued");
    assert.equal(await count(client, "fix_eval_runs"), 1);
    assert.equal(queued.length, 1);
    const again = await runEval(db, ON, models, queued);
    assert.equal((again as { data: { eval: { status: string } } }).data.eval.status, "queued");
    assert.equal(await count(client, "fix_eval_runs"), 1);
    assert.equal(queued.length, 1);
    const done = await simulateFixEvalJob(PROJECT, { runId: queued[0]! }, jobDeps(db, ON, models));
    assert.equal((done as { status?: string }).status, "completed");
  } finally {
    await client.close();
  }
});

test("with the gate off, run_eval refuses cleanly, queues nothing and calls no model", async () => {
  const { client, db } = await setup();
  try {
    const { models, calls } = countingModels();
    const result = await runEval(db, OFF, models);
    assert.deepEqual(result, {
      ok: false,
      error: "forbidden",
      message: EVAL_GATE_OFF_ERROR,
      reason: "eval_gate_off",
    });
    assert.equal(await count(client, "fix_eval_runs"), 0);
    assert.equal(calls(), 0);
  } finally {
    await client.close();
  }
});

test("a run queued before the gate was turned off is failed by the job with the reason, and nothing is called", async () => {
  const { client, db } = await setup();
  try {
    const { models, calls } = countingModels();
    const { set } = await createEvalSet(
      {
        projectId: PROJECT,
        fixId: `issue:${crypto.randomUUID()}`,
        fixKind: "fail-clearly",
        title: "Fail clearly",
        change: emptyChange(),
        source: null,
        createdBy: `project:${PROJECT}`,
      },
      db,
    );
    const { run } = await queueEvalRun(
      set,
      { trigger: "mcp", requestedBy: `project:${PROJECT}`, replay: true },
      db,
    );
    assert.deepEqual(
      await simulateFixEvalJob(PROJECT, { runId: run.id }, jobDeps(db, OFF, models)),
      {
        simulated: false,
        reason: "gate_off",
      },
    );
    const failed = await getEvalRun(run.id, db);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, EVAL_GATE_OFF_ERROR);
    assert.equal(calls(), 0);
  } finally {
    await client.close();
  }
});

test("a rewrite with no drafted text: run_eval refuses with why, and queues nothing, makes no set and calls no model (RC-77)", async () => {
  const { client, db } = await setup();
  try {
    const { models, calls } = countingModels();
    const queued: string[] = [];
    const undrafted = (projectId: string): Fix => ({
      ...fixFor(projectId),
      kind: "rewrite",
      kindLabel: "Rewrite the searchable description",
      detail: {
        source: "issue",
        changes: ["Rewrite get_seat_map's searchable description."],
        caveat: null,
      },
    });
    const result = await runEval(db, ON, models, queued, undrafted);
    assert.deepEqual(result, {
      ok: false,
      error: "conflict",
      message:
        "This fix has nothing to simulate yet, so no eval was queued. There's no drafted text to replay yet. Run an analysis on Quality to draft one.",
      reason: "nothing_to_simulate",
    });
    assert.equal(await count(client, "fix_eval_runs"), 0);
    assert.equal(await count(client, "fix_eval_sets"), 0);
    assert.equal(queued.length, 0);
    assert.equal(calls(), 0);
  } finally {
    await client.close();
  }
});
