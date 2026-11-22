import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { standInModels } from "@/lib/views/eval-gate/models";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { evalRuns } from "@/lib/views/evals/schema";
import { evalRunScores } from "@/lib/views/scorers/adapters/run-scores";
import { drizzleScorerRepository } from "@/lib/views/scorers/adapters/store";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { type EvalReplay, runEvalSetJob } from "../job";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TURN = "44444444-4444-4444-8444-444444444444";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};

test("RC-613: an eval run applies task and suite scorers, skips the one switched off for one eval, and judges the task criteria", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const store = createDrizzleEvalStore(db);
    const base = {
      projectId: PROJECT,
      message: "Pick seat 23A on R1",
      origin: "user" as const,
      createdBy: "t",
      status: "approved" as const,
      tasks: ["wf-1"],
      sourceTurnId: TURN,
    };
    const first = await store.createEval({
      ...base,
      name: "First",
      criteria: "The agent picks seat 23A.",
    });
    const second = await store.createEval({ ...base, name: "Second" });
    const repo = drizzleScorerRepository(db);
    const selects = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "wf-1",
      name: "Selects",
      kind: "check",
      config: { path: "toolNames", op: "contains", value: "select_seat" },
      createdBy: "t",
    });
    const names = await repo.create({
      projectId: PROJECT,
      scope: "suite",
      taskId: null,
      name: "Answers",
      kind: "expression",
      config: { logic: { "!!": [{ var: "finalAnswer" }] } },
      createdBy: "t",
    });
    const polite = await repo.create({
      projectId: PROJECT,
      scope: "suite",
      taskId: null,
      name: "Polite",
      kind: "judge",
      config: { criteria: "It is polite." },
      createdBy: "t",
    });
    await repo.setOverride(PROJECT, second.id, names.id, false, "t");

    const judged: string[] = [];
    const models = {
      ...standInModels(),
      judge: {
        model: "claude-sonnet-4-6",
        standIn: true,
        judge: async ({ criteria, run }: { criteria: string; run: string }) => {
          judged.push(criteria);
          return { pass: run.includes("23A"), usage: { inputTokens: 50, outputTokens: 2 } };
        },
      },
    };
    const [queued] = await db
      .insert(evalRuns)
      .values({ projectId: PROJECT, kind: "manual", status: "queued", createdBy: "t" })
      .returning();
    const recorded = seatRecording();
    await runEvalSetJob(
      PROJECT,
      { runId: queued!.id },
      {
        db,
        flagDeps: FLAGS_ON,
        models,
        observability: { trackSystemEvent: async () => undefined },
        loadReplays: async () => new Map<string, EvalReplay>([[TURN, recorded]]),
      },
    );

    const results = new Map(
      (await store.listResults(PROJECT, queued!.id)).map((result) => [result.evalId, result]),
    );
    assert.equal(
      results.get(first.id)!.verdicts.find((verdict) => verdict.kind === "judge_criteria")?.status,
      "pass",
      "The task criteria get a verdict.",
    );
    assert.equal(results.get(first.id)!.passed, true);
    assert.equal(results.get(second.id)!.passed, true);

    const scores = await evalRunScores(PROJECT, queued!.id, db);
    const of = (evalId: string) =>
      scores
        .filter((row) => row.evalId === evalId)
        .map((row) => [row.scorerId, row.status])
        .sort();
    assert.deepEqual(
      of(first.id),
      [
        [selects.id, "pass"],
        [names.id, "pass"],
        [polite.id, "pass"],
      ].sort(),
    );
    assert.deepEqual(
      of(second.id),
      [
        [selects.id, "pass"],
        [polite.id, "pass"],
      ].sort(),
      "The suite scorer switched off on this eval is not read.",
    );
    assert.ok(judged.includes("The agent picks seat 23A.") && judged.includes("It is polite."));
  } finally {
    await client.close();
  }
});

function seatRecording(): EvalReplay {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const steps = [
    { name: "get_seat_map", args: { ref: "R1" }, result: { free: ["23A"] } },
    { name: "select_seat", args: { ref: "R1", seat: "23A" }, result: { seat: "23A" } },
  ];
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: steps.map(({ name }) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
  const conversation: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Pick seat 23A on R1" }] },
  ];
  const calls: ModelCall[] = [];
  steps.forEach((step, index) => {
    const output: CloudMessage = {
      role: "assistant",
      content: [{ type: "tool_call", id: `toolu_${index}`, name: step.name, arguments: step.args }],
    };
    calls.push({
      turnId: TURN,
      occurredAt: at(index * 2),
      model: "claude-sonnet-4-6",
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900,
      outputTokens: 30,
      payload: payload([...conversation, output], "tool_call"),
    });
    conversation.push(output, {
      role: "tool",
      tool_call_id: `toolu_${index}`,
      content: JSON.stringify(step.result),
    });
  });
  const answer: CloudMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Seat 23A is yours." }],
  };
  calls.push({
    turnId: TURN,
    occurredAt: at(4),
    model: "claude-sonnet-4-6",
    finishReason: "stop",
    costUsd: 0.003,
    latencyMs: 800,
    inputTokens: 900,
    outputTokens: 30,
    payload: payload([...conversation, answer], "stop"),
  });
  const run: RunRecord = {
    turnId: TURN,
    traceId: "trace-1",
    startedAt: at(0).toISOString(),
    endedAt: at(4).toISOString(),
    taskId: "wf-1",
    steps: steps.map((step, index) => ({
      kind: "invoke",
      ordinal: index + 1,
      targetId: step.name,
      outcome: "ok",
    })),
    durationMs: 4000,
    costUsd: 0.009,
    answered: true,
  };
  return { run, calls };
}
