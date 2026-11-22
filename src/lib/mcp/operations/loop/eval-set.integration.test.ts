import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { evalSetData, latestEvalSetSimulation } from "@/lib/mcp/operations/loop/eval-set";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";

test("RC-626: the fix's newest eval-set simulation, each result with its stand-in answers and the generated inputs it used", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const store = createDrizzleEvalStore(db);
    assert.equal(await latestEvalSetSimulation(PROJECT, "fix-1", db), null, "No simulation yet.");
    const base = {
      projectId: PROJECT,
      message: "Hold my fare",
      origin: "user" as const,
      createdBy: "t",
      status: "approved" as const,
    };
    const spec = await store.createEval({ ...base, name: "Spec", generated: ["systemPrompt"] });
    const plain = await store.createEval({ ...base, name: "Plain" });
    const run = await store.createRun({
      projectId: PROJECT,
      kind: "simulation",
      fixId: "fix-1",
      createdBy: "t",
    });
    const standIn = {
      tool: "hold_fare",
      source: "stand-in" as const,
      reason: "stand_in_model" as const,
      ms: 1,
    };
    await store.recordResults(PROJECT, run.id, [
      {
        evalId: spec.id,
        side: "before",
        passed: true,
        verdicts: [],
        toolAnswers: [standIn],
        generated: ["systemPrompt"],
      },
      { evalId: plain.id, side: "before", passed: true, verdicts: [] },
    ]);
    const data = evalSetData((await latestEvalSetSimulation(PROJECT, "fix-1", db))!);
    assert.equal(data.runId, run.id);
    const byName = new Map(data.results.map((result) => [result.name, result]));
    assert.deepEqual(byName.get("Spec")!.standIns, { count: 1, tools: ["hold_fare"] });
    assert.deepEqual(byName.get("Spec")!.generated, ["systemPrompt"]);
    assert.ok(!("generated" in byName.get("Plain")!));
  } finally {
    await client.close();
  }
});
