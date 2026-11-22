import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { evals } from "@/lib/views/evals/schema";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { queueEvalRun } from "../run";
import {
  importTaskCases,
  MAX_SUGGESTIONS_PER_TASK,
  type RemoveEvalDeps,
  removeEval,
  suggestTaskEvals,
} from "../suggest";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const asks = async (_projectId: string, turnIds: readonly string[]) =>
  new Map(turnIds.map((id) => [id, `Ask of ${id.slice(0, 4)}`]));

test("a task suggests at most 5 evals, linked to it, and a second pass adds none", async () => {
  const { client, db } = await setup();
  try {
    await seedCases(
      db,
      "wf-1",
      Array.from({ length: 7 }, () => ({ origin: "auto" as const })),
    );
    assert.equal(
      await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks }),
      MAX_SUGGESTIONS_PER_TASK,
    );
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks }), 0);
    const evals = await createDrizzleEvalStore(db).listEvals(PROJECT, { workflowId: "wf-1" });
    assert.equal(evals.length, 5);
    assert.ok(
      evals.every(
        (e) =>
          e.status === "suggested" &&
          e.origin === "auto" &&
          e.sourceCaseId &&
          e.message.startsWith("Ask of "),
      ),
    );
    assert.deepEqual(evals[0]!.tasks, ["wf-1"]);
  } finally {
    await client.close();
  }
});

test("suggestions skip cases already imported or dismissed, and free slots refill", async () => {
  const { client, db } = await setup();
  try {
    const cases = await seedCases(
      db,
      "wf-1",
      Array.from({ length: 7 }, () => ({ origin: "auto" as const })),
    );
    const store = createDrizzleEvalStore(db);
    await store.createEval({
      projectId: PROJECT,
      name: "Already",
      message: "m",
      origin: "auto",
      createdBy: "t",
      status: "approved",
      sourceCaseId: cases[0]!,
      tasks: ["wf-1"],
    });
    assert.equal(await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks }), 5);
    const suggested = await store.listEvals(PROJECT, {
      workflowId: "wf-1",
      statuses: ["suggested"],
    });
    assert.ok(!suggested.some((e) => e.sourceCaseId === cases[0]));
    await store.setEvalStatus(PROJECT, suggested[0]!.id, "archived");
    assert.equal(
      await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks }),
      1,
      "A dismissed suggestion frees a slot for the last case.",
    );
    assert.equal(
      await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks }),
      0,
      "No case is left: the dismissed one is never suggested again.",
    );
  } finally {
    await client.close();
  }
});

test("pinned and user cases import once as approved evals; auto, excluded and fix cases do not", async () => {
  const { client, db } = await setup();
  try {
    await seedCases(db, "wf-1", [
      { origin: "auto", pinned: true },
      { origin: "user", testName: "Refund", testAsk: "Refund order 42" },
      { origin: "auto" },
      { origin: "user", excluded: true },
    ]);
    await seedCases(db, "wf-2", [{ origin: "fix", fixId: "craft:1" }, { origin: "user" }]);
    assert.equal(await importTaskCases(PROJECT, { db, loadAsks: asks }), 3);
    assert.equal(
      await importTaskCases(PROJECT, { db, loadAsks: asks }),
      0,
      "Import is idempotent.",
    );
    const evals = await createDrizzleEvalStore(db).listEvals(PROJECT);
    assert.equal(evals.length, 3);
    assert.ok(evals.every((e) => e.status === "approved"));
    const refund = evals.find((e) => e.name === "Refund")!;
    assert.equal(
      refund.message,
      "Refund order 42",
      "A user test's own ask wins over the captured one.",
    );
    assert.deepEqual(refund.tasks, ["wf-1"]);
  } finally {
    await client.close();
  }
});

test("RC-322: no project cap: every task suggests up to 5, and a manual run archives no suggested eval", async () => {
  const { client, db } = await setup();
  try {
    for (let task = 1; task <= 9; task++)
      await seedCases(
        db,
        `wf-${task}`,
        Array.from({ length: 5 }, () => ({ origin: "auto" as const })),
      );
    let added = 0;
    for (let task = 1; task <= 9; task++)
      added += await suggestTaskEvals(PROJECT, `wf-${task}`, { db, loadAsks: asks });
    assert.equal(added, 45);
    const store = createDrizzleEvalStore(db);
    // More than 5 on one task, as an older set may hold: still none is archived.
    for (let n = 0; n < 3; n++)
      await store.createEval({
        projectId: PROJECT,
        name: `Extra ${n}`,
        message: "m",
        origin: "auto",
        createdBy: "t",
        status: "suggested",
        tasks: ["wf-1"],
      });
    const run = await queueEvalRun(PROJECT, "user_1", null, db);
    assert.ok(run.ok, run.ok ? "" : run.error);
    assert.equal(run.value.run.evalCount, 48);
    assert.equal((await store.listEvals(PROJECT, { statuses: ["suggested"] })).length, 48);
  } finally {
    await client.close();
  }
});

test("remove archives any eval, suggested or not, and is tracked; an archived eval or the flag off refuses", async () => {
  const { client, db } = await setup();
  try {
    await seedCases(db, "wf-1", [{ origin: "auto" }]);
    await suggestTaskEvals(PROJECT, "wf-1", { db, loadAsks: asks });
    const store = createDrizzleEvalStore(db);
    const [suggested] = await store.listEvals(PROJECT);
    const approved = await store.createEval({
      projectId: PROJECT,
      name: "Mine",
      message: "m",
      origin: "user",
      createdBy: "t",
      status: "approved",
      tasks: ["wf-1"],
    });
    const tracked: string[] = [];
    const deps: RemoveEvalDeps = {
      db,
      flagDeps: FLAGS_ON,
      getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
      findProjectScope: async (projectId) => ({
        project: { id: projectId },
        organization: { id: ORG },
      }),
      track: async ({ evalId }) => {
        tracked.push(evalId);
      },
    };
    assert.deepEqual(await removeEval(PROJECT, suggested!.id, deps), {
      ok: true,
      value: "archived",
    });
    assert.deepEqual(await removeEval(PROJECT, approved.id, deps), { ok: true, value: "archived" });
    assert.deepEqual(tracked, [suggested!.id, approved.id]);
    assert.equal(
      (await removeEval(PROJECT, approved.id, deps)).ok,
      false,
      "An archived eval is gone already.",
    );
    const off = await removeEval(PROJECT, approved.id, {
      ...deps,
      flagDeps: { ...FLAGS_ON, evaluate: async () => false },
    });
    assert.deepEqual(off, { ok: false, error: "Evals are off for this organization." });
  } finally {
    await client.close();
  }
});

test("RC-608: with the gate on, a new eval gets a complete spec; captured values win and generated lists what the filler wrote", async () => {
  const { client, db } = await setup();
  try {
    const [recorded, bare] = await seedCases(db, "wf-1", [
      { origin: "user", testAsk: "Refund order 42" },
      { origin: "user" },
    ]);
    const turns = await db
      .select({ id: taskEvalCases.id, turnId: taskEvalCases.turnId })
      .from(taskEvalCases);
    const recordedTurn = turns.find((row) => row.id === recorded)!.turnId;
    const tool = {
      name: "refund",
      description: "Refund an order",
      parameters: { type: "object", properties: {} },
    };
    const loadCaptured = async () =>
      new Map([[recordedTurn, { systemPrompt: "Recorded prompt", tools: [tool], context: {} }]]);
    const asked: string[][] = [];
    const filler = {
      model: "test",
      async fill(request: { missing: readonly string[] }) {
        asked.push([...request.missing]);
        return {
          systemPrompt: "Generated prompt",
          message: "Generated ask",
          tools: [{ ...tool, name: "generated_tool" }],
          context: { order: "A42" },
        };
      },
    };
    const noAsk = async () => new Map<string, string>();
    assert.equal(
      await importTaskCases(PROJECT, {
        db,
        loadAsks: noAsk,
        flagDeps: FLAGS_ON,
        filler,
        loadCaptured,
      }),
      2,
    );
    const evals = await createDrizzleEvalStore(db).listEvals(PROJECT);
    const withRecording = evals.find((e) => e.sourceCaseId === recorded)!;
    assert.equal(withRecording.systemPrompt, "Recorded prompt");
    assert.equal(withRecording.message, "Refund order 42");
    assert.deepEqual(withRecording.tools, [tool]);
    assert.deepEqual(withRecording.context, {});
    assert.deepEqual(withRecording.generated, [], "Nothing was missing: the filler wrote nothing.");
    const withoutRecording = evals.find((e) => e.sourceCaseId === bare)!;
    assert.equal(withoutRecording.systemPrompt, "Generated prompt");
    assert.equal(withoutRecording.message, "Generated ask");
    assert.deepEqual(withoutRecording.context, { order: "A42" });
    assert.deepEqual(withoutRecording.generated, ["systemPrompt", "message", "tools", "context"]);
    assert.deepEqual(asked, [["systemPrompt", "message", "tools", "context"]]);
  } finally {
    await client.close();
  }
});

test("RC-608: a failing filler still saves the eval, with generated empty", async () => {
  const { client, db } = await setup();
  try {
    await seedCases(db, "wf-1", [{ origin: "user", testAsk: "Refund order 42" }]);
    const filler = {
      model: "test",
      async fill(): Promise<never> {
        throw new Error("model down");
      },
    };
    assert.equal(
      await importTaskCases(PROJECT, {
        db,
        loadAsks: asks,
        flagDeps: FLAGS_ON,
        filler,
        loadCaptured: async () => new Map(),
      }),
      1,
    );
    const [item] = await createDrizzleEvalStore(db).listEvals(PROJECT);
    assert.equal(item!.message, "Refund order 42");
    assert.deepEqual(item!.generated, []);
    assert.equal(item!.systemPrompt ?? null, null);
  } finally {
    await client.close();
  }
});

test("RC-608: with the gate off, eval creation writes the same rows as before", async () => {
  const { client, db } = await setup();
  try {
    await seedCases(db, "wf-1", [{ origin: "user", testAsk: "Refund order 42" }]);
    let called = false;
    const filler = {
      model: "test",
      async fill() {
        called = true;
        return {};
      },
    };
    const off = { ...FLAGS_ON, evaluate: async () => false };
    await importTaskCases(PROJECT, {
      db,
      loadAsks: asks,
      flagDeps: off,
      filler,
      loadCaptured: async () => {
        called = true;
        return new Map();
      },
    });
    assert.equal(called, false);
    const [row] = await db.select().from(evals);
    assert.deepEqual(
      [row!.systemPrompt, row!.tools, row!.context, row!.generated],
      [null, null, null, null],
    );
    const [item] = await createDrizzleEvalStore(db).listEvals(PROJECT);
    assert.ok(
      !("generated" in item!) && !("systemPrompt" in item!),
      "An eval without a spec reads as before.",
    );
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

type CaseSeed = {
  origin: "auto" | "issue" | "user" | "fix";
  pinned?: boolean;
  excluded?: boolean;
  fixId?: string;
  testName?: string;
  testAsk?: string;
};

async function seedCases(
  db: ReturnType<typeof getDb>,
  taskId: string,
  seeds: CaseSeed[],
): Promise<string[]> {
  await db
    .insert(taskEvalSets)
    .values({ projectId: PROJECT, taskId, scorerVersion: 1 })
    .onConflictDoNothing();
  const rows = await db
    .insert(taskEvalCases)
    .values(
      seeds.map((seed) => ({
        projectId: PROJECT,
        taskId,
        turnId: randomUUID(),
        origin: seed.origin,
        pinned: seed.pinned ?? false,
        excludedAt: seed.excluded ? new Date() : null,
        fixId: seed.fixId ?? null,
        testName: seed.testName ?? null,
        testAsk: seed.testAsk ?? null,
      })),
    )
    .returning({ id: taskEvalCases.id });
  return rows.map((row) => row.id);
}
