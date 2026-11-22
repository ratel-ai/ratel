// RP-150 parity capture: the six Evals MCP tools on one seed, run in ratel-cloud (frozen main) and in
// ratel (core). Same seed, same calls, stand-in models; each tool's answer is written to OUT.
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { type EvalSuiteDeps, evalSuiteReadOperations, evalSuiteWriteOperations } from "@/lib/mcp/operations/evals";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createMigratedPGlite } from "@/lib/db/test-support";
import { standInModels } from "@/lib/eval-gate/models";
import { createDrizzleEvalStore } from "@/lib/evals/adapters/drizzle-store";
import { scriptedSpecFiller } from "@/lib/evals/fill/filler";
import { runEvalSetJob } from "@/lib/evals/job";
import { seatRecording, TURN } from "@/lib/evals/tests/seat-recording";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON = { isConfigured: () => true, readOverride: () => undefined, evaluate: async () => true };
const AUTH: McpAuthContext = { kind: "api-key", projectId: PROJECT, apiKeyId: "key-1", scopes: ["*"], organization: { id: ORG, slug: "acme", effectivePlan: "pro" } };

test("parity capture", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const captured: { tool: string; params: unknown; answer: unknown }[] = [];
  try {
    await client.exec(`
      insert into organizations (id, name, slug, plan) values ('${ORG}', 'Acme', 'acme', 'pro');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const deps: EvalSuiteDeps = {
      evalGateEnabled: async () => true, db: () => db, filler: () => scriptedSpecFiller(),
      trackServerEvent: (async () => undefined) as unknown as EvalSuiteDeps["trackServerEvent"],
      catalog: () => ({ served: ["claude-sonnet-4-6", "claude-haiku-4-5"], notEnabled: new Set<string>() }),
    };
    const registry = buildRegistry([...evalSuiteReadOperations(deps), ...evalSuiteWriteOperations(deps)]);
    const call = async <T>(tool: string, params: Record<string, unknown>): Promise<T> => {
      const answer = await dispatchOperation(tool, params, { registry, auth: AUTH });
      captured.push({ tool, params, answer });
      return (answer as { data: T }).data;
    };
    const recorded = seatRecording();
    const runJob = (runId: string, evalId: string) => runEvalSetJob(PROJECT, { runId, evalId }, {
      db, flagDeps: FLAGS_ON as never, models: standInModels(), observability: { trackSystemEvent: async () => undefined },
      loadReplays: async (_projectId: string, turnIds: readonly string[]) => new Map(turnIds.filter((id) => id === TURN).map((id) => [id, recorded])),
    } as never);

    // change_scorer: a refused definition, a task scorer, a suite scorer, an update.
    await call("change_scorer", { action: "create", scope: "task", taskId: "book-seat", name: "X", kind: "expression", config: { logic: { regex: [1] } } });
    const quick = await call<{ scorer: { id: string } }>("change_scorer", { action: "create", scope: "task", taskId: "book-seat", name: "Quick", kind: "expression", config: { logic: { "<=": [{ var: "toolCallCount" }, 5] } } });
    await call("change_scorer", { action: "create", scope: "suite", name: "Answers", kind: "check", config: { path: "finalAnswer", op: "exists" } });
    await call("change_scorer", { action: "update", scorerId: quick.scorer.id, goodThreshold: 0.7 });
    // list_scorers: user scorers with the built-in ones.
    await call("list_scorers", { taskId: "book-seat" });
    await call("list_scorers", {});
    // change_eval: create by text (spec filled), a recorded eval, scorer switch, run settings.
    const created = await call<{ eval: { id: string } }>("change_eval", { action: "create", name: "Book seat 23A", message: "Book me seat 23A on flight R1.", tasks: ["book-seat"] });
    await call("change_eval", { action: "scorer_off", evalId: created.eval.id, scorerId: quick.scorer.id });
    const seat = await createDrizzleEvalStore(db).createEval({ projectId: PROJECT, name: "Seat", message: "Pick seat 23A on R1", origin: "user", createdBy: "t", status: "approved", sourceTurnId: TURN, systemPrompt: "You are a travel agent.", tools: [], generated: ["systemPrompt", "tools"] });
    await call("change_eval", { action: "update", evalId: seat.id, tools: [{ name: "select_seat", description: "Selects a seat." }] });
    await call("change_eval", { action: "set_suite_run_settings", runSettings: { judgeModel: "claude-haiku-4-5", maxSteps: 4 } });
    await call("change_eval", { action: "set_run_settings", evalId: seat.id, runSettings: { toolModel: "gpt-5" } });
    // list_evals: every eval with its switches and settings.
    await call("list_evals", {});
    await call("list_evals", { taskId: "book-seat" });
    // run_evals and get_eval_run: a run of the recorded eval, read back with its replay.
    const first = await call<{ runId: string }>("run_evals", { evalId: seat.id });
    await call("run_evals", { evalId: seat.id });
    await runJob(first.runId, seat.id);
    await call("get_eval_run", { runId: first.runId });
    const whole = await call<{ runId: string }>("run_evals", {});
    await runJob(whole.runId, seat.id);
    await call("get_eval_run", { runId: whole.runId });
    await call("get_eval_run", { runId: "44444444-4444-4444-8444-444444444444" });
  } finally {
    writeFileSync(process.env.OUT!, `${JSON.stringify(captured, null, 2)}\n`);
    await client.close();
  }
});
