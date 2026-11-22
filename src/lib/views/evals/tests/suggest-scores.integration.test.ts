import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { projects } from "@/lib/platform/projects/schema";
import { runScores, type ScorerRow, scorers } from "@/lib/views/scorers/schema";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { type SuggestDeps, suggestTaskEvals } from "../suggest";

/** RC-616: with the eval gate on, suggestions come from runs a scorer read under its good threshold. */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};

interface RunSeed {
  ask: string;
  path: string[];
  value: number | null;
  status?: "pass" | "fail" | "skip";
  version?: number;
  endedAt?: string;
}

test("only runs under the good threshold become suggestions, near-duplicates give one, and each names its scorer and score", async () => {
  const { client, db } = await setup();
  try {
    const quality = await seedScorer(db, "wf-1", "Answer quality", 0.7);
    const other = await seedScorer(db, "wf-2", "Other task scorer", 0.7);
    const runs = {
      refund42: { ask: "Refund order 42 please", path: ["lookup_order", "refund"], value: 0.2 },
      refund43: { ask: "refund order 43, please", path: ["lookup_order", "refund"], value: 0.3 },
      book: { ask: "Book a table for two tonight", path: ["book"], value: 0.6 },
      good: { ask: "Cancel my booking", path: ["cancel"], value: 0.9 },
      skipped: { ask: "Where is my parcel", path: ["track"], value: null, status: "skip" as const },
      stale: { ask: "Upgrade my plan", path: ["upgrade"], value: 0.1, version: 0 },
      seat: { ask: "Change my seat to the aisle", path: ["seat"], value: 0.1 },
    } satisfies Record<string, RunSeed>;
    const turns = await seedReadings(db, quality, runs);
    const elsewhere = await seedReadings(db, other, {
      far: { ask: "Other task ask", path: ["x"], value: 0 },
    });
    const store = createDrizzleEvalStore(db);
    await store.createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "change my seat to the aisle",
      origin: "user",
      createdBy: "t",
      status: "approved",
      tasks: ["wf-1"],
    });

    const filled: string[][] = [];
    const deps = depsFor(db, { ...turns, ...elsewhere }, runs, filled);
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", deps), 2);

    const suggested = await store.listEvals(PROJECT, {
      workflowId: "wf-1",
      statuses: ["suggested"],
    });
    const bySource = new Map(suggested.map((item) => [item.sourceTurnId, item]));
    assert.deepEqual(
      [...bySource.keys()].sort(),
      [turns.refund42, turns.book].sort(),
      "refund43 is a near-duplicate of refund42; seat matches an existing eval.",
    );
    assert.deepEqual(bySource.get(turns.refund42)!.suggestionReason, {
      scorerId: quality.id,
      scorerName: "Answer quality",
      value: 0.2,
      threshold: 0.7,
    });
    assert.deepEqual(bySource.get(turns.book)!.suggestionReason, {
      scorerId: quality.id,
      scorerName: "Answer quality",
      value: 0.6,
      threshold: 0.7,
    });
    assert.ok(
      suggested.every(
        (item) => item.origin === "auto" && item.sourceCaseId === null && item.tasks[0] === "wf-1",
      ),
    );
    assert.ok(
      suggested.every(
        (item) =>
          item.systemPrompt === "Generated prompt" && item.generated!.includes("systemPrompt"),
      ),
      "New suggestions go through the filler.",
    );
    assert.equal(filled.length, 2);

    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", deps), 0, "A second pass adds nothing.");
    await store.setEvalStatus(PROJECT, bySource.get(turns.book)!.id, "archived");
    assert.equal(
      await suggestTaskEvals(PROJECT, "wf-1", deps),
      0,
      "A removed suggestion never returns, and its near-duplicates stay out.",
    );
  } finally {
    await client.close();
  }
});

test("the worst runs fill the free slots first", async () => {
  const { client, db } = await setup();
  try {
    const quality = await seedScorer(db, "wf-1", "Answer quality", 0.8);
    const topics = ["flights", "hotels", "trains", "cars", "boats", "bikes", "buses"];
    const runs = Object.fromEntries(
      topics.map((topic, n) => [
        topic,
        { ask: `Find ${topic} near me`, path: [topic], value: n / 10 },
      ]),
    );
    const turns = await seedReadings(db, quality, runs);
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", depsFor(db, turns, runs, [])), 5);
    const suggested = await createDrizzleEvalStore(db).listEvals(PROJECT, {
      workflowId: "wf-1",
      statuses: ["suggested"],
    });
    assert.deepEqual(
      suggested.map((item) => item.sourceTurnId).sort(),
      topics
        .slice(0, 5)
        .map((topic) => turns[topic])
        .sort(),
    );
  } finally {
    await client.close();
  }
});

test("with the gate on, a task with no low readings gets no suggestion from its cases", async () => {
  const { client, db } = await setup();
  try {
    await db.insert(taskEvalSets).values({ projectId: PROJECT, taskId: "wf-1", scorerVersion: 1 });
    await db
      .insert(taskEvalCases)
      .values({ projectId: PROJECT, taskId: "wf-1", turnId: randomUUID(), origin: "auto" });
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", depsFor(db, {}, {}, [])), 0);
  } finally {
    await client.close();
  }
});

test("a low run whose ask names a project of another organization is not suggested (RC-853)", async () => {
  const { client, db } = await setup();
  try {
    const customerOrg = "44444444-4444-4444-8444-444444444444";
    const customer = "55555555-5555-4555-8555-555555555555";
    await db.insert(organizations).values({ id: customerOrg, name: "Customer", slug: "customer" });
    await db.insert(projects).values({
      id: customer,
      organizationId: customerOrg,
      name: "Customer agent",
      slug: "customer-agent",
    });
    const quality = await seedScorer(db, "wf-1", "Answer quality", 0.7);
    const runs = {
      foreign: { ask: `cluster_intents for project ${customer}`, path: ["cluster"], value: 0.1 },
      own: { ask: `cluster_intents for project ${PROJECT}`, path: ["label"], value: 0.2 },
    } satisfies Record<string, RunSeed>;
    const turns = await seedReadings(db, quality, runs);
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", depsFor(db, turns, runs, [])), 1);
    const suggested = await createDrizzleEvalStore(db).listEvals(PROJECT, {
      workflowId: "wf-1",
      statuses: ["suggested"],
    });
    assert.deepEqual(
      suggested.map((item) => item.sourceTurnId),
      [turns.own],
    );
  } finally {
    await client.close();
  }
});

function depsFor(
  db: ReturnType<typeof getDb>,
  turns: Record<string, string>,
  runs: Record<string, RunSeed>,
  filled: string[][],
): SuggestDeps {
  const byTurn = new Map(
    Object.entries(turns).map(([key, turnId]) => [
      turnId,
      runs[key] ?? { ask: "Other task ask", path: ["x"], value: 0 },
    ]),
  );
  const tool = {
    name: "refund",
    description: "Refund an order",
    parameters: { type: "object", properties: {} },
  };
  return {
    db,
    flagDeps: FLAGS_ON,
    loadAsks: async (_projectId, turnIds) =>
      new Map(turnIds.map((id) => [id, byTurn.get(id)?.ask ?? ""])),
    loadRunPaths: async (_projectId, turnIds) =>
      new Map(
        turnIds
          .filter((id) => byTurn.has(id))
          .map((id) => [
            id,
            {
              toolPath: byTurn.get(id)!.path,
              endedAt: new Date(byTurn.get(id)!.endedAt ?? "2026-11-01T10:00:00Z"),
            },
          ]),
      ),
    loadCaptured: async () => new Map(),
    filler: {
      model: "test",
      async fill(request: { missing: readonly string[] }) {
        filled.push([...request.missing]);
        return { systemPrompt: "Generated prompt", tools: [tool], context: {} };
      },
    },
  };
}

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db };
}

async function seedScorer(
  db: ReturnType<typeof getDb>,
  taskId: string,
  name: string,
  goodThreshold: number,
) {
  const [row] = await db
    .insert(scorers)
    .values({
      projectId: PROJECT,
      taskId,
      scope: "task",
      name,
      kind: "expression",
      config: {},
      goodThreshold,
      createdBy: "t",
      updatedBy: "t",
    })
    .returning();
  return row!;
}

async function seedReadings(
  db: ReturnType<typeof getDb>,
  scorer: ScorerRow,
  runs: Record<string, RunSeed>,
): Promise<Record<string, string>> {
  const turns = Object.fromEntries(Object.keys(runs).map((key) => [key, randomUUID()]));
  await db.insert(runScores).values(
    Object.entries(runs).map(([key, run]) => ({
      projectId: PROJECT,
      scorerId: scorer.id,
      scorerVersion: run.version ?? scorer.version,
      turnId: turns[key]!,
      day: "2026-11-01",
      status:
        run.status ?? (run.value !== null && run.value >= scorer.goodThreshold ? "pass" : "fail"),
      value: run.value,
      passed:
        run.status === "skip" ? null : run.value !== null && run.value >= scorer.goodThreshold,
    })),
  );
  return turns;
}
