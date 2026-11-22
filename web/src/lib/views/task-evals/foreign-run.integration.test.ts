import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { taskEvalCases, taskEvalSets, taskTestDrafts } from "@/lib/views/task-evals/schema";
import { changeTaskEval, type TaskEvalActionDeps, type TaskEvalRunRefusedEvent } from "./actions";
import { draftTestFromRun } from "./run-to-test";
import { refreshTaskEvalSet } from "./store";

/**
 * RC-853: a run that works on a project of another organization (our own
 * self-telemetry runs, `cluster_intents for project <uuid>`) must not become
 * an eval: eval rows do not expire, raw telemetry does.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ORG = "44444444-4444-4444-8444-444444444444";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SIBLING = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "55555555-5555-4555-8555-555555555555";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const proposal = {
  name: "Cluster the intents",
  ask: "Cluster the asks.",
  expected: {
    tool: "cluster",
    maxToolCalls: 3,
    maxSelfCorrections: 0,
    maxLatencyMs: 5000,
    maxCostUsd: 0.05,
  },
  criteria: "Return clusters.",
};

async function setup(ask: string | null) {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const events: unknown[] = [];
  const refusals: TaskEvalRunRefusedEvent[] = [];
  const deps: TaskEvalActionDeps = {
    db,
    getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
    enabled: async () => true,
    enqueue: async () => null,
    observe: async (fields) => {
      events.push(fields);
    },
    observeRefusal: async (fields) => {
      refusals.push(fields);
    },
  };
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Ratel', 'ratel'), ('${CUSTOMER_ORG}', 'Customer', 'customer');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Ratel', 'cloud'),
      ('${SIBLING}', '${ORG}', 'Sibling', 'sibling'),
      ('${CUSTOMER}', '${CUSTOMER_ORG}', 'Customer agent', 'customer-agent');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      values ('${TURN}', '${PROJECT}', 'job-1', 'otlp:trace-1', 'otlp', 'runtime', 'closed', now(), now(), now(), 'cluster_intents');
  `);
  if (ask !== null) {
    // Owned (ADR-0030): the core reads an OTLP run's ask from its model call; agent_run asks (RC-742) are not ported.
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, payload)
        values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', $1, 'otlp_model_call', 'job-1', now(), now(), 'otlp:model:trace-1:span-1', 'trace-1', $2)`,
      [PROJECT, JSON.stringify({ type: "otlp_model_call", prompt: ask })],
    );
  }
  const add = (withProposal = false) =>
    changeTaskEval(
      {
        action: "add",
        projectId: PROJECT,
        taskId: "cluster_intents",
        runId: TURN,
        ...(withProposal ? { proposal } : {}),
      },
      deps,
    );
  return { client, db, events, refusals, add };
}

test("a run whose ask names a project of another organization is refused and nothing is stored", async () => {
  const f = await setup(`cluster_intents for project ${CUSTOMER}\n{"limit":5}`);
  try {
    for (const withProposal of [false, true]) {
      assert.deepEqual(await f.add(withProposal), {
        ok: false,
        error:
          "This run works on a project of another organization, so it cannot become an eval here.",
      });
    }
    assert.equal((await f.db.select().from(taskEvalCases)).length, 0);
    assert.equal((await f.db.select().from(taskEvalSets)).length, 0);
    assert.equal(f.events.length, 0);
    assert.deepEqual(
      f.refusals.map((r) => [r.reason, r.foreign_projects, r.with_proposal, r.turn_id]),
      [
        ["foreign_project", 1, false, TURN],
        ["foreign_project", 1, true, TURN],
      ],
    );
    assert.ok(
      !JSON.stringify(f.refusals).includes(CUSTOMER),
      "The refusal names no customer project.",
    );
  } finally {
    await f.client.close();
  }
});

test("a run whose ask names a project of the same organization becomes an eval", async () => {
  const f = await setup(`cluster_intents for project ${SIBLING}`);
  try {
    assert.deepEqual(await f.add(true), { ok: true, message: "Run added." });
    assert.equal((await f.db.select().from(taskEvalCases)).length, 1);
  } finally {
    await f.client.close();
  }
});

test("a run whose ask names no project, or an id that is no project, becomes an eval", async () => {
  for (const ask of [
    "Where is the steel delivery?",
    "Track order 99999999-9999-4999-8999-999999999999",
    null,
  ]) {
    const f = await setup(ask);
    try {
      assert.deepEqual(await f.add(), { ok: true, message: "Run added." }, `ask: ${ask}`);
    } finally {
      await f.client.close();
    }
  }
});

test("a run whose root span names a project of another organization is refused", async () => {
  const f = await setup("Cluster the asks.");
  try {
    await f.client.query(
      `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
        values ('cccccccc-cccc-4ccc-8ccc-000000000001', $1, 'trace-1', 'span-1', null, 'invoke_agent cluster_intents', 1, 'agent', now(), now(), 1, 0, $2)`,
      [
        PROJECT,
        JSON.stringify({
          "gen_ai.agent.name": "cluster_intents",
          "ratel.job.project_id": CUSTOMER,
        }),
      ],
    );
    assert.deepEqual(await f.add(), {
      ok: false,
      error:
        "This run works on a project of another organization, so it cannot become an eval here.",
    });
    assert.equal((await f.db.select().from(taskEvalCases)).length, 0);
  } finally {
    await f.client.close();
  }
});

test("drafting a test from a run of another organization's project is refused before the model call", async () => {
  const f = await setup(`cluster_intents for project ${CUSTOMER}`);
  let calls = 0;
  try {
    await assert.rejects(
      draftTestFromRun(PROJECT, "cluster_intents", TURN, {
        db: f.db,
        // Owned (ADR-0030): the gate is the FF_EVAL_GATE env value, not an organization flag.
        flagDeps: { FF_EVAL_GATE: "1" },
        model: {
          model: "claude-haiku-5-5",
          standIn: false,
          draft: async () => {
            calls++;
            return { text: JSON.stringify(proposal), usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
      }),
      /works on a project of another organization/,
    );
    assert.equal(calls, 0);
    assert.equal((await f.db.select().from(taskTestDrafts)).length, 0, "No model budget is held.");
  } finally {
    await f.client.close();
  }
});

// Owned (ADR-0030): upstream's score suggestions (lib/evals/suggest.ts) are not ported; the core's
// automatic pick from scored runs is the eval-set refresh, so the same rule guards it.
test("the eval-set refresh does not pick a run of another organization's project", async () => {
  for (const [ask, picked] of [
    [`cluster_intents for project ${CUSTOMER}`, false],
    [`cluster_intents for project ${SIBLING}`, true],
  ] as const) {
    const f = await setup(ask);
    try {
      const result = await refreshTaskEvalSet(PROJECT, "cluster_intents", {
        db: f.db,
        flagDeps: { FF_EVAL_GATE: "1" },
        observability: { trackSystemEvent: async () => undefined },
      });
      assert.equal(result.refreshed, true);
      const cases = await f.db.select().from(taskEvalCases);
      assert.equal(
        cases.some((row) => row.turnId === TURN),
        picked,
        `ask: ${ask}`,
      );
    } finally {
      await f.client.close();
    }
  }
});
