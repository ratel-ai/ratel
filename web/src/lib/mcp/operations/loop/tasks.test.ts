import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { fixStats } from "@/lib/views/fixes/select";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { MAX_SCORERS } from "@/lib/views/scorers/config";
import { countScorers, listTaskScorers } from "@/lib/views/scorers/store";
import { resetTaskScorer, saveTaskScorer } from "@/lib/views/scorers/task-presets";
import type { changeTaskEval } from "@/lib/views/task-evals/actions";
import { draftTaskTest } from "@/lib/views/task-evals/draft-action";
import { TestDraftError } from "@/lib/views/task-evals/run-to-test";
import type { TaskEvalCaseRow } from "@/lib/views/task-evals/schema";
import { changeTaskSimulation } from "@/lib/views/task-evals/simulation-actions";
import type { TaskSimulationDetail } from "@/lib/views/task-evals/simulation-page";
import type { TestProposal } from "@/lib/views/task-evals/test-proposal";
import { changeTaskScorer } from "@/lib/views/task-scorers/actions";
import { scorersFor } from "@/lib/views/task-scorers/store";
import {
  defaultTaskDeps,
  loopTaskReadOperations,
  loopTaskWriteOperations,
  type TaskOperationDeps,
} from "./tasks";

/**
 * The task tools against injected reads and the real `lib/task-*` actions where
 * they need no database: each action reaches the lib call the console makes,
 * both gates refuse with their reason before anything runs, and every edit
 * emits the console's event with surface "mcp".
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const TASK = "book-flight";
const FIX = "craft:44444444-4444-4444-8444-444444444444";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const ACTOR = `project:${PROJECT}`;

const fix: Fix = {
  id: FIX,
  source: "craft",
  sourceId: FIX.slice(6),
  aliases: [FIX],
  title: "Merge find and hold",
  short: "Merge two tools",
  why: "w".repeat(500),
  kind: "merge",
  kindLabel: "Merge",
  group: "agent" as Fix["group"],
  status: "open",
  subject: {
    tools: [{ id: "find_flight", label: "find_flight", href: "/catalog" }],
    tasks: [{ id: TASK, label: "Book a flight", color: null, href: "/tasks" }],
    topics: [],
  },
  effect: null,
  gain: null,
  evidence: null,
  issues: [],
  actions: {
    apply: false,
    dismiss: true,
    revert: false,
    catalogHref: null,
    copy: null,
    descriptionHref: null,
  },
  detail: { source: "issue", changes: [], caveat: null },
  rank: { tier: 1, score: 1, count: 1 },
  appliedAt: null,
};
const other: Fix = {
  ...fix,
  id: "craft:other",
  aliases: ["craft:other"],
  subject: { ...fix.subject, tasks: [] },
};
const model: FixesModel = {
  projectId: PROJECT,
  open: [fix, other],
  applied: [],
  stats: fixStats([]),
  failed: [],
  rewritesOn: false,
  overridesAdopted: null,
};

const proposal: TestProposal = {
  name: "Books the Friday flight",
  ask: "Book me a flight to Lisbon on Friday",
  expected: {
    tool: "hold_fare",
    maxToolCalls: 4,
    maxSelfCorrections: null,
    maxLatencyMs: null,
    maxCostUsd: null,
  },
  criteria: "Holds a fare for Friday.",
};

function detail(over: Partial<TaskSimulationDetail> = {}): TaskSimulationDetail {
  return {
    shipments: [],
    projectId: PROJECT,
    taskId: TASK,
    fixId: FIX,
    title: fix.title,
    change: emptyChange(),
    draftStatus: "ready",
    tools: [{ id: "find_flight", label: "find_flight" }],
    state: { state: "better", stale: true },
    replayRuns: [],
    taskCases: Array.from({ length: 25 }, (_, i) => ({
      id: `case-${i}`,
      turnId: `turn-${i}`,
      origin: "auto" as const,
      pinned: false,
      excluded: false,
      ask: "a".repeat(400),
      chips: [],
      selectionReason: "",
      issueHref: null,
      runHref: "/runs",
    })),
    fixCases: [
      {
        id: CASE,
        turnId: RUN,
        ask: "Book",
        expected: {
          tool: "hold_fare",
          maxToolCalls: null,
          maxSearches: null,
          maxFailedCalls: null,
          avoidTools: [],
        },
        criteria: "Holds",
        runHref: "/runs",
      },
    ],
    runs: [],
    ...over,
  } as TaskSimulationDetail;
}

interface Tracked {
  name: string;
  properties: Record<string, unknown>;
}

function deps(events: Tracked[], over: Partial<TaskOperationDeps> = {}): TaskOperationDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("This call was not expected.");
  };
  return {
    ...defaultTaskDeps,
    evalGateEnabled: async () => true,
    loadProjectFixes: async () => model,
    taskSimulationListFor: async () => [
      {
        fixId: FIX,
        title: fix.title,
        why: fix.why,
        state: "better",
        stale: true,
        drafting: false,
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    taskSimulationDetailFor: async () => detail(),
    taskEvalCases: async () => [],
    saveScorer: unexpected,
    resetScorer: unexpected,
    enqueueTaskEvalRefresh: unexpected,
    draftTestFromRun: unexpected,
    loadFixContext: async (projectId, fixId) => (fixId === FIX ? { projectId, fix } : null),
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as TaskOperationDeps["trackServerEvent"],
    ...over,
  };
}

async function run(
  id: string,
  params: Record<string, unknown>,
  events: Tracked[] = [],
  over: Partial<TaskOperationDeps> = {},
) {
  const d = deps(events, over);
  return dispatchOperation(id, params, {
    registry: buildRegistry([...loopTaskReadOperations(d), ...loopTaskWriteOperations(d)]),
    auth,
  });
}

function data<T>(result: Awaited<ReturnType<typeof run>>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

function error(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result as unknown as { error: string; reason?: string; message: string };
}

const WRITES: [string, Record<string, unknown>][] = [
  ["change_task_scorer", { taskId: TASK, kind: "ends_well", enabled: true }],
  ["change_task_eval_set", { taskId: TASK, action: "refresh" }],
  ["draft_task_test", { taskId: TASK, runId: RUN }],
  [
    "change_task_simulation",
    { taskId: TASK, fixId: FIX, action: "draft", change: { patches: { find_flight: "Find." } } },
  ],
];

test("every task tool refuses with eval_gate_off and calls nothing", async () => {
  const touched: string[] = [];
  const spy = (name: string) => async (): Promise<never> => {
    touched.push(name);
    throw new Error("must not run");
  };
  const quiet: Partial<TaskOperationDeps> = {
    changeTaskScorer: spy("scorer"),
    changeTaskEval: spy("eval"),
    draftTaskTest: spy("draft"),
    changeTaskSimulation: spy("simulation"),
    taskSimulationListFor: spy("list"),
    loadProjectFixes: spy("fixes"),
  };
  for (const [id, params] of [
    ...WRITES,
    ["list_task_simulations", { taskId: TASK }] as [string, Record<string, unknown>],
  ]) {
    const events: Tracked[] = [];
    const gateOff = error(
      await run(id, params, events, { ...quiet, evalGateEnabled: async () => false }),
    );
    assert.deepEqual([gateOff.error, gateOff.reason], ["forbidden", "eval_gate_off"], id);
    assert.equal(events.length, 0, id);
  }
  assert.deepEqual(touched, []);
});

test("the eval gate is asked for the caller in the project", async () => {
  const asked: string[] = [];
  await run("list_task_simulations", { taskId: TASK }, [], {
    evalGateEnabled: async (projectId, actor) => (asked.push(`gate ${projectId} ${actor}`), true),
  });
  assert.deepEqual(asked, [`gate ${PROJECT} ${ACTOR}`]);
});

test("list_task_simulations lists each fix's latest simulation with stale and a link, cutting long text", async () => {
  const result = await run("list_task_simulations", { taskId: TASK });
  const out = data<{
    count: number;
    simulations: { fixId: string; state: string; stale: boolean; why: string; href: string }[];
  }>(result);
  assert.equal(out.count, 1);
  assert.equal(out.simulations[0]!.state, "better");
  assert.equal(out.simulations[0]!.stale, true);
  assert.equal(out.simulations[0]!.why.length, 301);
  assert.equal(
    out.simulations[0]!.href,
    `/project/${PROJECT}/tasks/${TASK}/simulations/${encodeURIComponent(FIX)}`,
  );
  assert.equal((result as DispatchSuccess).truncated, true);
});

test("list_task_simulations with fixId returns one simulation's detail, capped, and refuses a fix of another task", async () => {
  const reads: unknown[] = [];
  const result = await run("list_task_simulations", { taskId: TASK, fixId: FIX }, [], {
    taskSimulationDetailFor: async (projectId, taskId, f) => (
      reads.push([projectId, taskId, f.id]), detail()
    ),
  });
  const out = data<{
    simulation: {
      state: string;
      stale: boolean;
      draftStatus: string;
      fixTests: { caseId: string; runId: string }[];
      taskTestCount: number;
      taskTests: { ask: string }[];
      href: string;
    };
  }>(result);
  assert.deepEqual(reads, [[PROJECT, TASK, FIX]]);
  assert.equal(out.simulation.state, "better");
  assert.equal(out.simulation.stale, true);
  assert.equal(out.simulation.draftStatus, "ready");
  assert.deepEqual(
    out.simulation.fixTests.map((item) => [item.caseId, item.runId]),
    [[CASE, RUN]],
  );
  assert.equal(out.simulation.taskTestCount, 25);
  assert.equal(out.simulation.taskTests.length, 20);
  assert.equal(out.simulation.taskTests[0]!.ask.length, 301);
  assert.equal((result as DispatchSuccess).truncated, true);
  assert.match((result as DispatchSuccess).hint ?? "", /run_eval/);
  assert.equal(
    error(await run("list_task_simulations", { taskId: TASK, fixId: "craft:other" })).error,
    "not_found",
  );
});

test("change_task_scorer saves through the console's action as the caller, and emits task_scorer_updated", async () => {
  const events: Tracked[] = [];
  const saved: unknown[] = [];
  const out = data<{ kind: string; enabled: boolean }>(
    await run(
      "change_task_scorer",
      { taskId: TASK, kind: "max_tool_calls", max: 3, enabled: true },
      events,
      {
        saveScorer: async (input) => {
          saved.push(input);
        },
      },
    ),
  );
  assert.deepEqual(saved, [
    {
      projectId: PROJECT,
      taskId: TASK,
      scorer: { kind: "max_tool_calls", max: 3 },
      enabled: true,
      source: "user",
      updatedBy: ACTOR,
    },
  ]);
  assert.equal(out.enabled, true);
  assert.equal(events[0]!.name, "task_scorer_updated");
  assert.equal(events[0]!.properties.surface, "mcp");
  assert.equal(events[0]!.properties.kind, "max_tool_calls");
  assert.equal(events[0]!.properties.organization_id, "org-1");
});

test("change_task_scorer with the real sync: at the limit it refuses before any write", async () => {
  const scorers = MAX_SCORERS;
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'T', 't');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'A', 'a');
      insert into task_scorers (project_id, task_id, kind, config, enabled, source, updated_by)
        values ('${PROJECT}', '${TASK}', 'max_tool_calls', '{"max": 5}', true, 'user', 'u1');
      insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
        select '${PROJECT}', 'S' || n, 'check', '{"path":"duration_ms","op":"exists"}', 'u', 'u'
        from generate_series(1, ${scorers}) n;`);
    const legacy = async () => {
      const scorer = (await scorersFor(PROJECT, TASK, db)).find(
        (candidate) => candidate.kind === "max_tool_calls",
      );
      return scorer?.kind === "max_tool_calls" ? scorer.max : null;
    };
    const result = await run(
      "change_task_scorer",
      { taskId: TASK, kind: "max_tool_calls", max: 3, enabled: true },
      [],
      {
        changeTaskScorer,
        saveScorer: (input) => saveTaskScorer(input, db),
        resetScorer: (projectId, taskId, kind, actor) =>
          resetTaskScorer(projectId, taskId, kind, actor, db),
      },
    );
    const label = `${scorers} scorers`;
    const refused = error(result);
    assert.equal(refused.error, "conflict", label);
    assert.match(refused.message, /limit is 100/, label);
    assert.equal(await legacy(), 5, label);
    // The refused change creates nothing.
    assert.equal(await countScorers(PROJECT, db), scorers, label);
  } finally {
    await client.close();
  }
});

test("change_task_scorer with the real sync under the limit: the converted scorer follows", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'T', 't');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'A', 'a');`);
    data(
      await run(
        "change_task_scorer",
        { taskId: TASK, kind: "max_tool_calls", max: 3, enabled: true },
        [],
        {
          changeTaskScorer,
          saveScorer: (input) => saveTaskScorer(input, db),
        },
      ),
    );
    assert.deepEqual(
      (await listTaskScorers(PROJECT, TASK, db)).map((scorer) => scorer.config),
      [{ preset: "max_tool_calls", max: 3 }],
    );
  } finally {
    await client.close();
  }
});

test("change_task_scorer resets, and refuses a scorer without its setting or a save without enabled", async () => {
  const reset: unknown[] = [];
  data(
    await run("change_task_scorer", { taskId: TASK, kind: "judge_criteria", action: "reset" }, [], {
      resetScorer: async (...args) => {
        reset.push(args);
      },
    }),
  );
  assert.deepEqual(reset, [[PROJECT, TASK, "judge_criteria", ACTOR]]);
  const noMax = error(
    await run("change_task_scorer", { taskId: TASK, kind: "max_cost_usd", enabled: true }),
  );
  assert.equal(noMax.error, "invalid_params");
  assert.match(noMax.message, /Pass max/);
  assert.equal(
    error(
      await run("change_task_scorer", {
        taskId: TASK,
        kind: "max_tool_calls",
        max: 2.5,
        enabled: true,
      }),
    ).error,
    "invalid_params",
  );
  assert.equal(
    error(await run("change_task_scorer", { taskId: TASK, kind: "ends_well" })).error,
    "invalid_params",
  );
});

test("change_task_eval_set routes each action to the console's changeTaskEval input", async () => {
  const inputs: unknown[] = [];
  const fake: typeof changeTaskEval = async (raw, d) => {
    inputs.push(raw);
    await d.observe({
      project_id: PROJECT,
      organization_id: "org-1",
      task_id: TASK,
      actor: ACTOR,
      action: (raw as { action: "add" }).action,
    });
    return { ok: true, message: "Done." };
  };
  const excluded = {
    id: CASE,
    projectId: PROJECT,
    taskId: TASK,
    turnId: RUN,
    origin: "auto",
    fixId: null,
    pinned: false,
    excludedAt: new Date(),
    expected: {},
    criteria: "",
    selectionReason: "",
    testName: null,
    testAsk: null,
  } satisfies TaskEvalCaseRow;
  const events: Tracked[] = [];
  const over = { changeTaskEval: fake, taskEvalCases: async () => [excluded] };
  const base = { projectId: PROJECT, taskId: TASK };
  for (const action of ["pin", "unpin", "exclude"])
    data(await run("change_task_eval_set", { taskId: TASK, action, caseId: CASE }, events, over));
  data(
    await run(
      "change_task_eval_set",
      { taskId: TASK, action: "add", runId: RUN, proposal },
      events,
      over,
    ),
  );
  data(
    await run(
      "change_task_eval_set",
      { taskId: TASK, action: "restore", caseId: CASE },
      events,
      over,
    ),
  );
  data(
    await run(
      "change_task_eval_set",
      { taskId: TASK, action: "restore", runId: RUN },
      events,
      over,
    ),
  );
  assert.deepEqual(inputs, [
    { ...base, action: "pin", caseId: CASE },
    { ...base, action: "unpin", caseId: CASE },
    { ...base, action: "exclude", caseId: CASE },
    { ...base, action: "add", runId: RUN, proposal },
    { ...base, action: "add", runId: RUN },
    { ...base, action: "add", runId: RUN },
  ]);
  assert.ok(
    events.every(
      (event) => event.name === "task_eval_case_changed" && event.properties.surface === "mcp",
    ),
  );
  assert.equal(
    error(await run("change_task_eval_set", { taskId: TASK, action: "pin" }, [], over)).error,
    "invalid_params",
  );
  assert.equal(
    error(
      await run(
        "change_task_eval_set",
        { taskId: TASK, action: "restore", caseId: "55555555-5555-4555-8555-555555555555" },
        [],
        over,
      ),
    ).error,
    "not_found",
  );
  assert.equal(
    error(
      await run(
        "change_task_eval_set",
        { taskId: TASK, action: "pin", caseId: CASE, proposal },
        [],
        over,
      ),
    ).error,
    "invalid_params",
  );
});

test("change_task_eval_set refresh queues the refresh job and returns its id for get_job_status", async () => {
  const events: Tracked[] = [];
  const queued: unknown[] = [];
  const result = await run("change_task_eval_set", { taskId: TASK, action: "refresh" }, events, {
    enqueueTaskEvalRefresh: async (...args) => (queued.push(args), { id: "job-1" }),
  });
  const out = data<{ jobId: string }>(result);
  assert.deepEqual(queued, [[PROJECT, TASK]]);
  assert.equal(out.jobId, "job-1");
  assert.match((result as DispatchSuccess).hint ?? "", /get_job_status/);
  assert.equal(events[0]!.name, "task_eval_case_changed");
  assert.equal(events[0]!.properties.action, "refresh");
});

test("change_task_eval_set saving a drafted test emits task_test_saved as the console does", async () => {
  const events: Tracked[] = [];
  data(
    await run(
      "change_task_eval_set",
      { taskId: TASK, action: "add", runId: RUN, proposal },
      events,
      {
        changeTaskEval: async (_raw, d) => {
          await d.observe({
            project_id: PROJECT,
            organization_id: "org-1",
            task_id: TASK,
            actor: ACTOR,
            action: "add",
            case_id: CASE,
            turn_id: RUN,
            test_saved: true,
          });
          return { ok: true, message: "Run added." };
        },
      },
    ),
  );
  assert.deepEqual(
    events.map((event) => event.name),
    ["task_eval_case_changed", "task_test_saved"],
  );
});

test("change_task_eval_set turns the action's refusals into tool errors", async () => {
  const refuse = (message: string) => ({
    changeTaskEval: (async () => ({ ok: false, error: message })) as typeof changeTaskEval,
  });
  assert.equal(
    error(
      await run(
        "change_task_eval_set",
        { taskId: TASK, action: "add", runId: RUN },
        [],
        refuse("No run in this project has that ID."),
      ),
    ).error,
    "not_found",
  );
  assert.equal(
    error(
      await run(
        "change_task_eval_set",
        { taskId: TASK, action: "add", runId: RUN },
        [],
        refuse("This run is already in the eval set."),
      ),
    ).error,
    "conflict",
  );
  assert.equal(
    error(
      await run(
        "change_task_eval_set",
        { taskId: TASK, action: "add", runId: RUN },
        [],
        refuse("The eval settings are invalid."),
      ),
    ).error,
    "invalid_params",
  );
});

test("draft_task_test drafts through the console's action as the caller, saves nothing, and emits task_test_drafted", async () => {
  const events: Tracked[] = [];
  const drafted: unknown[] = [];
  const result = await run("draft_task_test", { taskId: TASK, runId: RUN }, events, {
    draftTaskTest,
    draftTestFromRun: async (...args) => (drafted.push(args), proposal),
  });
  const out = data<{ proposal: TestProposal; runId: string }>(result);
  assert.deepEqual(drafted, [[PROJECT, TASK, RUN, ACTOR]]);
  assert.deepEqual(out.proposal, proposal);
  assert.match((result as DispatchSuccess).hint ?? "", /change_task_eval_set/);
  assert.equal(events[0]!.name, "task_test_drafted");
  assert.equal(events[0]!.properties.surface, "mcp");
  const refused = error(
    await run("draft_task_test", { taskId: TASK, runId: RUN }, [], {
      draftTestFromRun: async () => {
        throw new TestDraftError("The daily model budget is spent. Try again tomorrow.");
      },
    }),
  );
  assert.equal(refused.error, "conflict");
  assert.match(refused.message, /budget/);
});

test("change_task_simulation maps each action to the console's input, passing only the expected fields given", async () => {
  const inputs: unknown[] = [];
  const events: Tracked[] = [];
  const over: Partial<TaskOperationDeps> = {
    changeTaskSimulation: async (raw, d) => {
      inputs.push(raw);
      await d.observe({
        project_id: PROJECT,
        organization_id: "org-1",
        task_id: TASK,
        fix_id: FIX,
        actor: ACTOR,
        what: "test",
      });
      return { ok: true, message: "Saved." };
    },
  };
  const base = { projectId: PROJECT, taskId: TASK, fixId: FIX };
  const change = { ...emptyChange(), patches: { find_flight: "Find a flight." } };
  data(
    await run(
      "change_task_simulation",
      { taskId: TASK, fixId: FIX, action: "draft", change },
      events,
      over,
    ),
  );
  data(
    await run(
      "change_task_simulation",
      {
        taskId: TASK,
        fixId: FIX,
        action: "add_test",
        runId: RUN,
        expected: { tool: "hold_fare", avoidTools: ["a", "a"] },
        criteria: "Holds",
      },
      events,
      over,
    ),
  );
  data(
    await run(
      "change_task_simulation",
      {
        taskId: TASK,
        fixId: FIX,
        action: "edit_test",
        caseId: CASE,
        expected: { maxToolCalls: 3 },
      },
      events,
      over,
    ),
  );
  assert.deepEqual(inputs, [
    { ...base, action: "draft", change },
    {
      ...base,
      action: "add-test",
      runId: RUN,
      expected: { tool: "hold_fare", avoidTools: ["a"] },
      criteria: "Holds",
    },
    { ...base, action: "edit-test", caseId: CASE, expected: { maxToolCalls: 3 }, criteria: "" },
  ]);
  assert.ok(
    events.every(
      (event) => event.name === "task_simulation_edited" && event.properties.surface === "mcp",
    ),
  );
  assert.equal(
    error(
      await run("change_task_simulation", { taskId: TASK, fixId: FIX, action: "draft" }, [], over),
    ).error,
    "invalid_params",
  );
  assert.equal(
    error(
      await run(
        "change_task_simulation",
        { taskId: TASK, fixId: FIX, action: "edit_test" },
        [],
        over,
      ),
    ).error,
    "invalid_params",
  );
});

test("change_task_simulation input passes the console's own checks, which then refuse a fix of another task", async () => {
  const result = error(
    await run(
      "change_task_simulation",
      {
        taskId: TASK,
        fixId: "craft:other",
        action: "add_test",
        runId: RUN,
        expected: { tool: "hold_fare", maxCostUsd: 0.5, endsWell: true },
        criteria: "Holds",
      },
      [],
      { changeTaskSimulation },
    ),
  );
  assert.equal(result.error, "not_found");
  assert.equal(result.message, "This fix does not belong to this task.");
  const noEffect = error(
    await run(
      "change_task_simulation",
      { taskId: TASK, fixId: FIX, action: "draft", change: { version: 1 } },
      [],
      { changeTaskSimulation },
    ),
  );
  assert.equal(noEffect.error, "invalid_params");
});

test("change_task_scorer runs the real action end to end with the console's parse", async () => {
  const saved: unknown[] = [];
  data(
    await run(
      "change_task_scorer",
      { taskId: TASK, kind: "expected_tool", tool: " hold_fare ", enabled: false },
      [],
      {
        changeTaskScorer,
        saveScorer: async (input) => {
          saved.push(input);
        },
      },
    ),
  );
  assert.deepEqual((saved[0] as { scorer: unknown }).scorer, {
    kind: "expected_tool",
    tool: "hold_fare",
  });
});
