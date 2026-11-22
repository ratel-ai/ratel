import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import {
  type EvalSuiteDeps,
  evalSuiteReadOperations,
  evalSuiteWriteOperations,
} from "@/lib/mcp/operations/evals";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { standInModels } from "@/lib/views/eval-gate/models";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";
import { scriptedSpecFiller } from "@/lib/views/evals/fill/filler";
import { runEvalSetJob } from "@/lib/views/evals/job";
import { seatRecording, TURN } from "@/lib/views/evals/tests/seat-recording";

/**
 * Owned (ADR-0030): the organizations fixture has no plan column (the plan is the entitlements
 * port's), and the last case pins the core's FF_EVALS gate: off, every Evals tool is forbidden.
 */
const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const AUTH: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: ORG, slug: "acme", effectivePlan: "pro" },
};

test("RC-614: an agent creates a JSONLogic scorer, adds an eval by text, switches the scorer off on it, runs it and reads the result", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const events: string[] = [];
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async () => true,
      db: () => db,
      filler: () => scriptedSpecFiller(),
      trackServerEvent: (async (event: string) => {
        events.push(event);
      }) as unknown as EvalSuiteDeps["trackServerEvent"],
    };
    const registry = buildRegistry([
      ...evalSuiteReadOperations(deps),
      ...evalSuiteWriteOperations(deps),
    ]);
    const call = async <T>(id: string, params: Record<string, unknown>): Promise<T> => {
      const result = await dispatchOperation(id, params, { registry, auth: AUTH });
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { data: T }).data;
    };

    const bad = await dispatchOperation(
      "change_scorer",
      {
        action: "create",
        scope: "task",
        taskId: "book-seat",
        name: "X",
        kind: "expression",
        config: { logic: { regex: [1] } },
      },
      { registry, auth: AUTH },
    );
    assert.equal(bad.ok, false);
    assert.match(JSON.stringify(bad), /Unknown JSONLogic operator \\"regex\\"/);

    const quick = await call<{ scorer: { id: string } }>("change_scorer", {
      action: "create",
      scope: "task",
      taskId: "book-seat",
      name: "Quick",
      kind: "expression",
      config: { logic: { "<=": [{ var: "toolCallCount" }, 5] } },
    });
    const answers = await call<{ scorer: { id: string } }>("change_scorer", {
      action: "create",
      scope: "suite",
      name: "Answers",
      kind: "check",
      config: { path: "finalAnswer", op: "exists" },
    });
    const listed = await call<{ scorers: { id: string; builtIn: boolean }[] }>("list_scorers", {
      taskId: "book-seat",
    });
    assert.ok(listed.scorers.some((scorer) => scorer.id === quick.scorer.id && !scorer.builtIn));
    assert.ok(
      listed.scorers.some((scorer) => scorer.id === "legacy:book-seat:ends_well" && scorer.builtIn),
      "Built-in scorers show in the same list.",
    );

    const created = await call<{ eval: { id: string; generated: string[] } }>("change_eval", {
      action: "create",
      name: "Book seat 23A",
      message: "Book me seat 23A on flight R1.",
      tasks: ["book-seat"],
    });
    assert.ok(
      created.eval.generated.includes("systemPrompt"),
      "A model wrote the missing spec fields.",
    );
    await call("change_eval", {
      action: "scorer_off",
      evalId: created.eval.id,
      scorerId: quick.scorer.id,
    });
    // RC-616: a score-based suggestion names the reading that made it.
    const reason = { scorerId: quick.scorer.id, scorerName: "Quick", value: 0.2, threshold: 0.5 };
    const suggestion = await createDrizzleEvalStore(db).createEval({
      projectId: PROJECT,
      name: "Slow booking",
      message: "Book a seat",
      origin: "auto",
      createdBy: "system:evals",
      tasks: ["book-seat"],
      suggestionReason: reason,
    });
    const evals = await call<{
      evals: { id: string; scorersOff: string[]; suggestedBecause: unknown }[];
    }>("list_evals", {});
    assert.deepEqual(evals.evals.find((item) => item.id === created.eval.id)?.scorersOff, [
      quick.scorer.id,
    ]);
    assert.equal(evals.evals.find((item) => item.id === created.eval.id)?.suggestedBecause, null);
    assert.deepEqual(
      evals.evals.find((item) => item.id === suggestion.id)?.suggestedBecause,
      reason,
    );

    const queued = await call<{ runId: string; created: boolean }>("run_evals", {
      evalId: created.eval.id,
    });
    assert.equal(queued.created, true);
    // The drain runs the queued job.
    await runEvalSetJob(
      PROJECT,
      { runId: queued.runId, evalId: created.eval.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models: standInModels(),
        observability: { trackSystemEvent: async () => undefined },
      },
    );

    const run = await call<{
      status: string;
      results: {
        evalId: string;
        generated?: string[];
        standIns: { count: number };
        scores: { scorerId: string; status: string }[];
      }[];
    }>("get_eval_run", { runId: queued.runId });
    assert.equal(run.status, "completed");
    const [result] = run.results;
    assert.equal(result!.evalId, created.eval.id);
    assert.ok(result!.generated && result!.generated.length > 0);
    assert.equal(typeof result!.standIns.count, "number");
    assert.deepEqual(
      result!.scores.map((score) => score.scorerId),
      [answers.scorer.id],
      "The scorer switched off on this eval is not read.",
    );
    assert.deepEqual(
      events.filter((event) => event !== "eval_run_queued"),
      ["scorer_changed", "scorer_changed", "eval_created", "eval_scorer_switched"],
    );
  } finally {
    await client.close();
  }
});

test("RC-641: an agent edits the spec, sets a step's answer, runs the eval, reads the replay steps and continues from step 2", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const events: string[] = [];
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async () => true,
      db: () => db,
      filler: () => null,
      trackServerEvent: (async (event: string) => {
        events.push(event);
      }) as unknown as EvalSuiteDeps["trackServerEvent"],
    };
    const registry = buildRegistry([
      ...evalSuiteReadOperations(deps),
      ...evalSuiteWriteOperations(deps),
    ]);
    const call = async <T>(id: string, params: Record<string, unknown>): Promise<T> => {
      const result = await dispatchOperation(id, params, { registry, auth: AUTH });
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { data: T }).data;
    };
    const recorded = seatRecording();
    const runJob = (runId: string, evalId: string) =>
      runEvalSetJob(
        PROJECT,
        { runId, evalId },
        {
          db,
          flagDeps: FLAGS_ON,
          models: standInModels(),
          observability: { trackSystemEvent: async () => undefined },
          loadReplays: async (_projectId, turnIds) =>
            new Map(turnIds.filter((id) => id === TURN).map((id) => [id, recorded])),
        },
      );
    type Step = {
      index: number;
      role: string;
      tool?: string;
      source?: string | null;
      args?: Record<string, unknown>;
    };
    type Run = {
      results: {
        evalId: string;
        replay?: {
          systemPrompt: string | null;
          message: string;
          toolsOffered: string[];
          steps: Step[];
        };
      }[];
    };
    const item = await createDrizzleEvalStore(db).createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
      systemPrompt: "You are a travel agent.",
      tools: [],
      generated: ["systemPrompt", "tools"],
    });

    const edited = await call<{ eval: { generated: string[] } }>("change_eval", {
      action: "update",
      evalId: item.id,
      tools: [{ name: "select_seat", description: "Selects a seat." }],
    });
    assert.deepEqual(
      edited.eval.generated,
      ["systemPrompt"],
      "The edited spec field is no longer generated.",
    );

    const first = await call<{ runId: string }>("run_evals", { evalId: item.id });
    await runJob(first.runId, item.id);
    const before = await call<Run>("get_eval_run", { runId: first.runId });
    const replay = before.results[0]!.replay!;
    assert.equal(replay.systemPrompt, "You are a travel agent.");
    assert.equal(replay.message, "Pick seat 23A on R1");
    assert.deepEqual(
      replay.toolsOffered,
      ["select_seat"],
      "RC-642: the edited tool list wins over the recording.",
    );
    const select = replay.steps.find(
      (step) => step.role === "tool" && step.tool === "select_seat",
    )!;
    assert.deepEqual([select.source, select.args], ["recorded", { ref: "R1", seat: "23A" }]);

    const set = await call<{ fixedAnswers: { tool: string; when: unknown }[] }>("change_eval", {
      action: "set_step_answer",
      evalId: item.id,
      runId: first.runId,
      step: select.index,
      answer: '{"error":"seat taken"}',
    });
    assert.deepEqual(
      set.fixedAnswers.map((answer) => [answer.tool, answer.when]),
      [["select_seat", { ref: "R1", seat: "23A" }]],
    );
    const second = await call<{ runId: string; created: boolean }>("run_evals", {
      evalId: item.id,
    });
    assert.equal(second.created, true);
    await runJob(second.runId, item.id);
    const after = await call<Run>("get_eval_run", { runId: second.runId });
    assert.equal(
      after.results[0]!.replay!.steps.find((step) => step.tool === "select_seat")!.source,
      "mock",
    );

    const continued = await call<{ eval: { id: string }; earlierCount: number; runId: string }>(
      "change_eval",
      { action: "continue_from_step", evalId: item.id, runId: first.runId, step: 2 },
    );
    assert.notEqual(continued.eval.id, item.id);
    assert.equal(
      continued.earlierCount,
      2,
      "Steps 0..2: the answered select_seat call and the reply.",
    );
    await runJob(continued.runId, continued.eval.id);
    const copyRun = await call<Run>("get_eval_run", { runId: continued.runId });
    assert.equal(copyRun.results[0]!.evalId, continued.eval.id);

    const bad = await dispatchOperation(
      "change_eval",
      { action: "set_step_answer", evalId: item.id, runId: first.runId, step: 0, answer: "x" },
      { registry, auth: AUTH },
    );
    assert.equal(bad.ok, false);
    assert.match(JSON.stringify(bad), /Step 0 is not a tool answer/);
    assert.deepEqual(
      events.filter(
        (event) => event === "eval_step_answer_set" || event === "eval_continued_from_step",
      ),
      ["eval_step_answer_set", "eval_continued_from_step"],
    );
  } finally {
    await client.close();
  }
});

test("RC-653: an agent sets the suite's and an eval's run settings, a bad model is refused, and get_eval_run returns the settings used", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const events: string[] = [];
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async () => true,
      db: () => db,
      filler: () => null,
      trackServerEvent: (async (event: string) => {
        events.push(event);
      }) as unknown as EvalSuiteDeps["trackServerEvent"],
      catalog: () => ({
        served: ["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"],
        notEnabled: new Set(["claude-opus-4-8"]),
      }),
    };
    const registry = buildRegistry([
      ...evalSuiteReadOperations(deps),
      ...evalSuiteWriteOperations(deps),
    ]);
    const call = async <T>(id: string, params: Record<string, unknown>): Promise<T> => {
      const result = await dispatchOperation(id, params, { registry, auth: AUTH });
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { data: T }).data;
    };
    const item = await createDrizzleEvalStore(db).createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
    });

    const suite = await call<{ runSettings: Record<string, unknown> }>("change_eval", {
      action: "set_suite_run_settings",
      runSettings: { judgeModel: "claude-haiku-4-5", maxSteps: 4 },
    });
    assert.deepEqual(suite.runSettings, { judgeModel: "claude-haiku-4-5", maxSteps: 4 });
    const disabled = await dispatchOperation(
      "change_eval",
      {
        action: "set_run_settings",
        evalId: item.id,
        runSettings: { agentModel: "claude-opus-4-8" },
      },
      { registry, auth: AUTH },
    );
    assert.equal(disabled.ok, false);
    assert.match(
      JSON.stringify(disabled),
      /claude-opus-4-8 is not enabled on Bedrock \(model_not_enabled\)/,
    );
    const unknown = await dispatchOperation(
      "change_eval",
      { action: "set_run_settings", evalId: item.id, runSettings: { toolModel: "gpt-5" } },
      { registry, auth: AUTH },
    );
    assert.match(JSON.stringify(unknown), /gpt-5 is not a Claude model that this backend serves/);
    const set = await call<{ runSettings: Record<string, unknown> }>("change_eval", {
      action: "set_run_settings",
      evalId: item.id,
      runSettings: {
        agentModel: "claude-sonnet-4-6",
        temperature: 0.4,
        maxSteps: 1,
        toolModel: null,
      },
    });
    assert.deepEqual(set.runSettings, {
      agentModel: "claude-sonnet-4-6",
      temperature: 0.4,
      maxSteps: 1,
    });
    const listed = await call<{ evals: { id: string; runSettings?: unknown }[] }>("list_evals", {});
    assert.deepEqual(
      listed.evals.find((entry) => entry.id === item.id)?.runSettings,
      set.runSettings,
    );

    const queued = await call<{ runId: string }>("run_evals", { evalId: item.id });
    const recorded = seatRecording();
    await runEvalSetJob(
      PROJECT,
      { runId: queued.runId, evalId: item.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models: standInModels(),
        observability: { trackSystemEvent: async () => undefined },
        loadReplays: async (_projectId, turnIds) =>
          new Map(turnIds.filter((id) => id === TURN).map((id) => [id, recorded])),
      },
    );
    const run = await call<{
      results: { runSettings: Record<string, unknown> & { sources: Record<string, string> } }[];
    }>("get_eval_run", { runId: queued.runId });
    const used = run.results[0]!.runSettings;
    assert.deepEqual(
      [used.agentModel, used.temperature, used.maxSteps, used.judgeModel],
      ["claude-sonnet-4-6", 0.4, 1, "claude-haiku-4-5"],
    );
    assert.deepEqual(
      [used.sources.agentModel, used.sources.judgeModel, used.sources.budgetUsd],
      ["eval", "suite", "default"],
    );
    assert.deepEqual(
      events.filter((event) => event === "eval_run_settings_set"),
      ["eval_run_settings_set", "eval_run_settings_set"],
    );

    const cleared = await call<{ runSettings: Record<string, unknown> }>("change_eval", {
      action: "set_run_settings",
      evalId: item.id,
      runSettings: {},
    });
    assert.deepEqual(cleared.runSettings, {});
  } finally {
    await client.close();
  }
});

test("RC-654: an agent edits the agent reply at step 2 of a run, on a copy, and the copy's run starts with that reply", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const events: string[] = [];
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async () => true,
      db: () => db,
      filler: () => null,
      trackServerEvent: (async (event: string) => {
        events.push(event);
      }) as unknown as EvalSuiteDeps["trackServerEvent"],
    };
    const registry = buildRegistry([
      ...evalSuiteReadOperations(deps),
      ...evalSuiteWriteOperations(deps),
    ]);
    const call = async <T>(id: string, params: Record<string, unknown>): Promise<T> => {
      const result = await dispatchOperation(id, params, { registry, auth: AUTH });
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { data: T }).data;
    };
    const recorded = seatRecording();
    const runJob = (runId: string, evalId: string) =>
      runEvalSetJob(
        PROJECT,
        { runId, evalId },
        {
          db,
          flagDeps: FLAGS_ON,
          models: standInModels(),
          observability: { trackSystemEvent: async () => undefined },
          loadReplays: async (_projectId, turnIds) =>
            new Map(turnIds.filter((id) => id === TURN).map((id) => [id, recorded])),
        },
      );
    type Step = {
      index: number;
      role: string;
      text?: string;
      calls?: { name: string; args: Record<string, unknown> }[];
    };
    const item = await createDrizzleEvalStore(db).createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
    });
    const first = await call<{ runId: string }>("run_evals", { evalId: item.id });
    await runJob(first.runId, item.id);

    const bad = await dispatchOperation(
      "change_eval",
      { action: "edit_reply", evalId: item.id, runId: first.runId, step: 1, reply: { text: "x" } },
      { registry, auth: AUTH },
    );
    assert.match(JSON.stringify(bad), /Step 1 is not an agent reply/);
    const reply = {
      text: "Let me take 12C instead.",
      calls: [{ name: "select_seat", args: { ref: "R1", seat: "12C" } }],
    };
    const edited = await call<{
      target: string;
      eval: { id: string; name: string };
      openingSteps: number;
      runId: string;
    }>("change_eval", {
      action: "edit_reply",
      evalId: item.id,
      runId: first.runId,
      step: 2,
      reply,
      target: "copy",
    });
    assert.deepEqual(
      [edited.target, edited.eval.name, edited.openingSteps],
      ["copy", "Seat (edited reply)", 3],
    );
    assert.notEqual(edited.eval.id, item.id);
    await runJob(edited.runId, edited.eval.id);
    const run = await call<{ results: { replay?: { steps: Step[] } }[] }>("get_eval_run", {
      runId: edited.runId,
    });
    const third = run.results[0]!.replay!.steps[2]!;
    assert.deepEqual(
      [third.role, third.text, third.calls],
      ["assistant", reply.text, reply.calls],
      "The copy's run starts with the edited reply at step 2.",
    );
    assert.ok(events.includes("eval_reply_edited"));
  } finally {
    await client.close();
  }
});

test("FF_EVALS off: each of the six Evals tools refuses as forbidden and writes nothing", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const asked: string[] = [];
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async (_projectId, actor) => {
        asked.push(actor);
        return false;
      },
      db: () => db,
      filler: () => scriptedSpecFiller(),
      trackServerEvent: (async () => undefined) as unknown as EvalSuiteDeps["trackServerEvent"],
    };
    const registry = buildRegistry([
      ...evalSuiteReadOperations(deps),
      ...evalSuiteWriteOperations(deps),
    ]);
    const calls: [string, Record<string, unknown>][] = [
      ["list_scorers", {}],
      ["list_evals", {}],
      ["get_eval_run", { runId: "44444444-4444-4444-8444-444444444444" }],
      ["change_scorer", { action: "create", scope: "suite", name: "X", kind: "check", config: {} }],
      ["change_eval", { action: "create", name: "Refund", message: "refund order 42" }],
      ["run_evals", {}],
    ];
    for (const [id, params] of calls) {
      const result = await dispatchOperation(id, params, { registry, auth: AUTH });
      assert.equal(result.ok, false, id);
      assert.equal((result as { error: string }).error, "forbidden", id);
      assert.match(JSON.stringify(result), /Evals are off/, id);
    }
    assert.equal(asked.length, calls.length);
    assert.deepEqual(new Set(asked), new Set([`project:${PROJECT}`]));
    assert.equal((await createDrizzleEvalStore(db).listEvals(PROJECT)).length, 0);
    assert.equal((await createDrizzleEvalStore(db).listRuns(PROJECT)).length, 0);
  } finally {
    await client.close();
  }
});
