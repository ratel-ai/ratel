import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import type { AnthropicClient } from "@/lib/readings/anthropic/client";
import { CANT_SIMULATE, notEnabledReason } from "@/lib/views/eval-gate/method";
import {
  anthropicAgent,
  defaultRunSettings,
  type EvalModels,
  resolveEvalModels,
  STAND_IN_MODEL,
  scriptedAgent,
  standInModels,
} from "@/lib/views/eval-gate/models";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import type { ModelCatalog, RunSettingsUsed } from "../domain/run-settings";
import { EVALS_OFF_ERROR } from "../gate";
import { type EvalReplay, type RunEvalSetDeps, runEvalSetJob } from "../job";
import { queueEvalRun } from "../run";
import {
  checkRunSettings,
  loadRunSettingsModel,
  type SaveRunSettingsDeps,
  saveRunSettings,
} from "../run-settings";
import { seatRecording, TURN } from "./seat-recording";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const NO_EVENTS = { trackSystemEvent: async () => undefined };
const CATALOG: ModelCatalog = {
  served: [
    "claude-opus-5-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-haiku-5-5",
    "claude-opus-4-8",
  ],
  notEnabled: new Set(["claude-opus-4-8"]),
};

test("RC-653: an eval runs with its agent model, temperature and step limit, and the result records them", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const item = await createEval(db);
    await store.setSuiteRunSettings(
      PROJECT,
      { judgeModel: "claude-haiku-4-5", maxSteps: 6 },
      "user_1",
    );
    const saved = await checkRunSettings(
      { agentModel: "claude-sonnet-4-6", temperature: 0.4, maxSteps: 1 },
      store,
      PROJECT,
      "eval",
      CATALOG,
    );
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    await store.setEvalRunSettings(PROJECT, item.id, saved.value);
    const seen: RunSettingsUsed[] = [];
    const runId = await runOne(db, item, {
      modelsFor: (settings) => {
        seen.push(settings);
        return standInModels(settings.maxTokens);
      },
    });
    const [result] = await store.listResults(PROJECT, runId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.agentModel, "claude-sonnet-4-6");
    assert.equal(seen[0]!.temperature, 0.4);
    assert.equal(
      result!.toolCalls,
      1,
      "The step limit of 1 stops the replay after its first call.",
    );
    assert.deepEqual(result!.runSettings, {
      ...defaultRunSettings(),
      agentModel: "claude-sonnet-4-6",
      temperature: 0.4,
      maxSteps: 1,
      judgeModel: "claude-haiku-4-5",
      sources: {
        agentModel: "eval",
        temperature: "eval",
        maxTokens: "default",
        maxSteps: "eval",
        budgetUsd: "default",
        toolModel: "default",
        judgeModel: "suite",
      },
    });
  } finally {
    await client.close();
  }
});

test("RC-653: an eval without settings runs with today's defaults, and a cleared setting falls back to the suite", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const item = await createEval(db);
    const runId = await runOne(db, item, { models: standInModels() });
    const [result] = await store.listResults(PROJECT, runId);
    assert.equal(result!.toolCalls, 2, "Today's step limit runs the whole recording.");
    assert.ok(Object.values(result!.runSettings!.sources).every((source) => source === "default"));
    await store.setEvalRunSettings(PROJECT, item.id, { maxSteps: 1 });
    assert.deepEqual((await store.getEval(PROJECT, item.id))!.runSettings, { maxSteps: 1 });
    await store.setEvalRunSettings(PROJECT, item.id, {});
    assert.equal(
      (await store.getEval(PROJECT, item.id))!.runSettings,
      undefined,
      "An empty object clears them.",
    );
  } finally {
    await client.close();
  }
});

test("RC-653: the eval's cost budget caps its run", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const item = await createEval(db);
    await store.setEvalRunSettings(PROJECT, item.id, { budgetUsd: 0.000_1 });
    const priced: EvalModels = {
      ...standInModels(),
      agent: ({ recorded }) => scriptedAgent(recorded, "claude-sonnet-4-6"),
    };
    const runId = await runOne(db, item, { models: priced });
    const run = (await store.getRun(PROJECT, runId))!;
    assert.ok(run.spend.reservedUsd <= 0.000_1 + 1e-12, `reserved ${run.spend.reservedUsd}`);
    const [result] = await store.listResults(PROJECT, runId);
    assert.equal(result!.error, CANT_SIMULATE.budget);
    assert.equal(result!.runSettings!.budgetUsd, 0.000_1);
  } finally {
    await client.close();
  }
});

test("RC-653: a chosen model that Bedrock has not enabled does not run, and the result names model_not_enabled", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const item = await createEval(db);
    await store.setEvalRunSettings(PROJECT, item.id, { agentModel: "claude-opus-4-8" });
    let built = 0;
    const runId = await runOne(db, item, {
      catalog: CATALOG,
      modelsFor: () => {
        built += 1;
        return standInModels();
      },
    });
    const [result] = await store.listResults(PROJECT, runId);
    assert.equal(result!.error, notEnabledReason("claude-opus-4-8"));
    assert.equal(built, 0, "No model is called.");
  } finally {
    await client.close();
  }
});

test("RC-653: an unknown or not-enabled model is refused at save time with a clear message", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const unknown = await checkRunSettings(
      { agentModel: "gpt-5" },
      store,
      PROJECT,
      "eval",
      CATALOG,
    );
    assert.equal(unknown.ok, false);
    assert.match(
      !unknown.ok ? unknown.error : "",
      /^gpt-5 is not a Claude model that this backend serves\. Choose one of: claude-opus-5-5, /,
    );
    const disabled = await checkRunSettings(
      { judgeModel: "claude-opus-4-8" },
      store,
      PROJECT,
      "suite",
      CATALOG,
    );
    assert.deepEqual(disabled, {
      ok: false,
      error: "claude-opus-4-8 is not enabled on Bedrock (model_not_enabled). Choose another model.",
      reason: "model_not_enabled",
    });
    await store.setSuiteRunSettings(PROJECT, { agentModel: "claude-opus-5-5" }, "user_1");
    const noTemperature = await checkRunSettings(
      { temperature: 0.5 },
      store,
      PROJECT,
      "eval",
      CATALOG,
    );
    assert.match(
      !noTemperature.ok ? noTemperature.error : "",
      /claude-opus-5-5 does not take a temperature/,
      "The suite's agent model counts.",
    );
  } finally {
    await client.close();
  }
});

test("RC-653: the agent call sends the eval's temperature and max tokens, and a 5.x model gets no temperature", async () => {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const fake: AnthropicClient = {
    messages: {
      create: (async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        sent.push(params);
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text: "ok", citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }) as never,
      stream: (() => {
        throw new Error("no stream");
      }) as never,
    },
  };
  const input = { system: undefined, tools: [], messages: [{ role: "user" as const, text: "hi" }] };
  await anthropicAgent(fake, "claude-sonnet-4-6", "claude-opus-5-5", "eval_gate_replay", {
    temperature: 0.4,
    maxTokens: 2000,
  }).next(input);
  await anthropicAgent(fake, "claude-opus-5-5", "claude-opus-5-5", "eval_gate_replay", {
    temperature: 0.4,
    maxTokens: 2000,
  }).next(input);
  await anthropicAgent(fake, "claude-sonnet-4-6").next(input);
  assert.deepEqual(
    sent.map((params) => [params.model, params.temperature, params.max_tokens]),
    [
      ["claude-sonnet-4-6", 0.4, 2000],
      ["claude-opus-5-5", undefined, 2000],
      ["claude-sonnet-4-6", 0, 4096],
    ],
  );
});

test("RC-653: resolveEvalModels uses the settings' agent, stand-in and judge models; with the stand-ins on, nothing changes but max tokens", () => {
  const env = { ANTHROPIC_API_KEY: "test-key" };
  const settings = {
    ...defaultRunSettings(env),
    agentModel: "claude-sonnet-4-6",
    toolModel: "claude-haiku-4-5",
    judgeModel: "claude-opus-5-5",
  };
  const models = resolveEvalModels(
    env,
    "eval_gate_judge",
    "production",
    "eval_gate_replay",
    settings,
  );
  assert.equal(
    models.agent!({ recordedModel: "claude-opus-4-8", recorded: [] })!.model,
    "claude-sonnet-4-6",
  );
  assert.equal(models.tool!.model, "claude-haiku-4-5");
  assert.equal(models.person!.model, "claude-haiku-4-5");
  assert.equal(models.judge!.model, "claude-opus-5-5");
  const today = resolveEvalModels(env, "eval_gate_judge", "production");
  assert.equal(
    today.agent!({ recordedModel: "claude-opus-4-8", recorded: [] })!.model,
    "claude-opus-4-8",
    "No settings: the recorded model, as before.",
  );
  const local = resolveEvalModels(
    { EVAL_GATE_MOCK_MODEL: "1" },
    "eval_gate_judge",
    "test",
    "eval_gate_replay",
    { ...settings, maxTokens: 900 },
  );
  const agent = local.agent!({ recordedModel: null, recorded: [] })!;
  assert.deepEqual([agent.model, agent.maxTokens], [STAND_IN_MODEL, 900]);
});

test("RC-653: the form saves an eval's and the suite's settings only with the flag on, and lists only enabled models", async () => {
  const { client, db } = await setup();
  try {
    const item = await createEval(db);
    const deps = (flags: OrganizationFlagDeps): SaveRunSettingsDeps => ({
      db,
      flagDeps: flags,
      catalog: CATALOG,
      getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
      findProjectScope: async (projectId) => ({
        project: { id: projectId },
        organization: { id: ORG },
      }),
    });
    const off = await saveRunSettings(
      PROJECT,
      item.id,
      { maxSteps: 2 },
      deps({ ...FLAGS_ON, evaluate: async () => false }),
    );
    assert.deepEqual(off, { ok: false, error: EVALS_OFF_ERROR });
    assert.deepEqual(await saveRunSettings(PROJECT, null, { maxSteps: 4 }, deps(FLAGS_ON)), {
      ok: true,
      value: { maxSteps: 4 },
    });
    assert.deepEqual(
      await saveRunSettings(
        PROJECT,
        item.id,
        { agentModel: "claude-sonnet-4-6", temperature: 0.4 },
        deps(FLAGS_ON),
      ),
      { ok: true, value: { agentModel: "claude-sonnet-4-6", temperature: 0.4 } },
    );
    const refused = await saveRunSettings(
      PROJECT,
      item.id,
      { agentModel: "claude-opus-4-8" },
      deps(FLAGS_ON),
    );
    assert.match(!refused.ok ? refused.error : "", /model_not_enabled/);
    const store = createDrizzleEvalStore(db);
    const form = await loadRunSettingsModel(PROJECT, (await store.getEval(PROJECT, item.id))!, {
      db,
      catalog: CATALOG,
      defaults: defaultRunSettings(),
    });
    assert.deepEqual(form.own, { agentModel: "claude-sonnet-4-6", temperature: 0.4 });
    assert.equal(form.inherited.maxSteps, 4, "An empty field shows the suite default.");
    assert.ok(!form.models.includes("claude-opus-4-8"));
    assert.deepEqual(form.notEnabled, ["claude-opus-4-8"]);
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db };
}

function createEval(db: ReturnType<typeof getDb>) {
  return createDrizzleEvalStore(db).createEval({
    projectId: PROJECT,
    name: "Seat",
    message: "Pick seat 23A on R1",
    origin: "user",
    createdBy: "t",
    status: "approved",
    sourceTurnId: TURN,
  });
}

/** Queue a run of the one eval and run its job; the run's id. */
async function runOne(
  db: ReturnType<typeof getDb>,
  item: { id: string; name: string },
  deps: Partial<RunEvalSetDeps>,
): Promise<string> {
  const queued = await queueEvalRun(PROJECT, "user_1", null, db, "manual", undefined, item);
  assert.ok(queued.ok, queued.ok ? "" : queued.error);
  const recorded = seatRecording();
  await runEvalSetJob(
    PROJECT,
    { runId: queued.value.run.id, evalId: item.id },
    {
      db,
      flagDeps: FLAGS_ON,
      observability: NO_EVENTS,
      catalog: { served: [], notEnabled: new Set() },
      loadReplays: async (_projectId, turnIds) =>
        new Map<string, EvalReplay>(
          turnIds.filter((id) => id === TURN).map((id) => [id, recorded]),
        ),
      ...deps,
    },
  );
  return queued.value.run.id;
}
