import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { type EvalForm, formFromEval } from "../domain/edit";
import { simulateSpecAgain, type UpdateEvalDeps, updateEval } from "../edit";
import { parseRunEvalSetPayload } from "../run";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const FLAGS_OFF: OrganizationFlagDeps = { ...FLAGS_ON, evaluate: async () => false };

test("RC-297: Save validates, replaces the fields and task links, and tracks eval_updated once", async () => {
  const { client, db, deps, tracked, item } = await setup();
  try {
    const form: EvalForm = {
      ...formFromEval(item, []),
      name: "Aisle seat, edited",
      earlier: [
        { role: "user", text: "Hi, I'm Ana" },
        { role: "tool", tool: "find_booking", args: '{"ref":"R1"}', text: '{"booking":"R1"}' },
      ],
      turns: [{ kind: "person", text: "A traveler in a hurry" }],
      tasks: ["wf-b", "wf-a"],
      fixedAnswers: [
        {
          tool: "select_seat",
          when: '{"seat":"14C"}',
          answer: '{"ok":true}',
          why: "Seat changes are free",
        },
      ],
    };
    const saved = await updateEval(PROJECT, item.id, form, false, deps);
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    assert.equal(saved.value.run, null);
    const read = (await createDrizzleEvalStore(db).getEval(PROJECT, item.id))!;
    assert.equal(read.name, "Aisle seat, edited");
    assert.deepEqual(read.tasks, ["wf-a", "wf-b"]);
    assert.deepEqual(read.turns, [{ kind: "person", description: "A traveler in a hurry" }]);
    assert.deepEqual(read.earlierMessages[1], {
      role: "tool",
      tool: "find_booking",
      args: { ref: "R1" },
      text: '{"booking":"R1"}',
    });
    assert.deepEqual(read.fixedAnswers, [
      {
        tool: "select_seat",
        result: { ok: true },
        when: { seat: "14C" },
        why: "Seat changes are free",
      },
    ]);
    assert.equal(read.message, item.message, "Turn 1 stays the recorded ask.");
    assert.deepEqual(tracked, [
      { evalId: item.id, run: false, turnCount: 2, fixedAnswerCount: 1, earlierCount: 2 },
    ]);
    assert.equal((await db.select().from(jobs)).length, 0);
  } finally {
    await client.close();
  }
});

test("RC-297: Save and run queues a manual run of this eval only", async () => {
  const { client, db, deps, item } = await setup();
  try {
    const saved = await updateEval(PROJECT, item.id, formFromEval(item, []), true, deps);
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    assert.equal(saved.value.run!.kind, "manual");
    assert.equal(saved.value.run!.evalCount, 1);
    const [job] = await db.select().from(jobs);
    assert.deepEqual(parseRunEvalSetPayload(job!.payload), {
      runId: saved.value.run!.id,
      evalId: item.id,
    });
  } finally {
    await client.close();
  }
});

test("RC-297: an invalid form, the flag off or another project's eval saves nothing", async () => {
  const { client, db, deps, tracked, item } = await setup();
  try {
    const bad = await updateEval(
      PROJECT,
      item.id,
      { ...formFromEval(item, []), name: " " },
      false,
      deps,
    );
    assert.deepEqual(bad, { ok: false, error: "Give the eval a name." });
    const flagOff = await updateEval(PROJECT, item.id, formFromEval(item, []), false, {
      ...deps,
      flagDeps: FLAGS_OFF,
    });
    assert.equal(flagOff.ok, false);
    const unknown = await updateEval(
      PROJECT,
      "33333333-3333-4333-8333-333333333333",
      formFromEval(item, []),
      false,
      deps,
    );
    assert.deepEqual(unknown, { ok: false, error: "No eval in this project has that ID." });
    assert.equal((await createDrizzleEvalStore(db).getEval(PROJECT, item.id))!.name, item.name);
    assert.equal(tracked.length, 0);
  } finally {
    await client.close();
  }
});

test("RC-641: Save sets the spec fields the person changed; only those leave the generated list", async () => {
  const { client, db, deps } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const tools = [
      {
        name: "find_booking",
        description: "Finds a booking.",
        parameters: { type: "object", properties: {} },
      },
    ];
    const item = await store.createEval({
      projectId: PROJECT,
      name: "Spec",
      message: "Move me",
      origin: "user",
      createdBy: "t",
      status: "approved",
      systemPrompt: "You are a travel agent.",
      tools,
      context: { booking: "R1" },
      generated: ["systemPrompt", "tools", "context"],
    });
    const start = formFromEval(item, []);
    const saved = await updateEval(
      PROJECT,
      item.id,
      {
        ...start,
        spec: { ...start.spec!, systemPrompt: "Be brief.", tools: '[{"name": "select_seat"}]' },
      },
      false,
      deps,
    );
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    const read = (await store.getEval(PROJECT, item.id))!;
    assert.equal(read.systemPrompt, "Be brief.");
    assert.deepEqual(read.tools, [
      { name: "select_seat", description: "", parameters: { type: "object", properties: {} } },
    ]);
    assert.deepEqual(read.context, { booking: "R1" });
    assert.deepEqual(read.generated, ["context"]);
    assert.deepEqual(
      read.edited,
      ["systemPrompt", "tools"],
      "RC-642: the edited fields win over the recording when it replays.",
    );
    const unchanged = await updateEval(PROJECT, item.id, formFromEval(read, []), false, deps);
    assert.ok(unchanged.ok);
    assert.deepEqual(
      (await store.getEval(PROJECT, item.id))!.generated,
      ["context"],
      "Saving the same spec keeps the generated list.",
    );
  } finally {
    await client.close();
  }
});

test("RC-642: Simulate again after a system prompt edit saves only that field and queues a run of the eval", async () => {
  const { client, db, deps } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const item = await store.createEval({
      projectId: PROJECT,
      name: "Spec",
      message: "Move me",
      origin: "user",
      createdBy: "t",
      status: "approved",
      systemPrompt: "You are a travel agent.",
      context: { booking: "R1" },
      generated: ["systemPrompt", "context"],
    });
    const again = await simulateSpecAgain(
      PROJECT,
      item.id,
      { systemPrompt: "Answer in one sentence." },
      { ...deps, track: undefined },
    );
    assert.ok(again.ok, again.ok ? "" : again.error);
    assert.equal(again.value.item.systemPrompt, "Answer in one sentence.");
    assert.deepEqual(again.value.item.generated, ["context"]);
    assert.equal(again.value.run.evalCount, 1);
    const [job] = await db.select().from(jobs);
    assert.deepEqual(parseRunEvalSetPayload(job!.payload), {
      runId: again.value.run.id,
      evalId: item.id,
    });
    assert.deepEqual(
      await simulateSpecAgain(PROJECT, item.id, { message: " " }, { ...deps, track: undefined }),
      { ok: false, error: "Write the message the agent gets." },
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
  const item = await createDrizzleEvalStore(db).createEval({
    projectId: PROJECT,
    name: "Aisle seat",
    message: "Move me to an aisle seat",
    origin: "user",
    createdBy: "t",
    status: "approved",
    tasks: ["wf-a"],
  });
  const tracked: {
    evalId: string;
    run: boolean;
    turnCount: number;
    fixedAnswerCount: number;
    earlierCount: number;
  }[] = [];
  const deps: UpdateEvalDeps = {
    db,
    flagDeps: FLAGS_ON,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT ? { project: { id: projectId }, organization: { id: ORG } } : null,
    track: async ({ evalId, run, turnCount, fixedAnswerCount, earlierCount }) => {
      tracked.push({ evalId, run, turnCount, fixedAnswerCount, earlierCount });
    },
  };
  return { client, db, deps, tracked, item };
}
