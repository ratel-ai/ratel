import assert from "node:assert/strict";
import { test } from "node:test";
import { traceTurns } from "@/lib/ledger/schema";
import { createTaskLinks } from "../adapters/task-links";
import { createEvalsDb, PROJECT_ID } from "./support";

test("the tasks of a trace match the trace id in any case", async () => {
  const { db } = await createEvalsDb();
  const now = new Date();
  await db.insert(traceTurns).values({
    projectId: PROJECT_ID,
    workflowId: "wf-refunds",
    sessionId: "s1",
    turnKey: "otlp:abcdef0123456789",
    turnSource: "otlp",
    lane: "runtime",
    status: "closed",
    startedAt: now,
    endedAt: now,
    lastReceivedAt: now,
  });
  const tasks = await createTaskLinks(db).tasksOfTrace(PROJECT_ID, "ABCDEF0123456789");
  assert.deepEqual(
    tasks.map(({ id }) => id),
    ["wf-refunds"],
  );
});

test("the task of a sandbox is named by its sandbox", async () => {
  const { db } = await createEvalsDb();
  const now = new Date();
  await db.insert(traceTurns).values({
    projectId: PROJECT_ID,
    workflowId: "sandbox:support-demo",
    sessionId: "s1",
    turnKey: "otlp:0123",
    turnSource: "otlp",
    lane: "runtime",
    status: "closed",
    startedAt: now,
    endedAt: now,
    lastReceivedAt: now,
  });
  assert.deepEqual(await createTaskLinks(db).tasksOfTrace(PROJECT_ID, "0123"), [
    { id: "sandbox:support-demo", name: "support-demo" },
  ]);
});
