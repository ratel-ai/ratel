import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { evalExperiments } from "../schema";
import { createEvalSandboxVersionHolds } from "../version-holds";
import { createEvalsDb, ORGANIZATION_ID, PROJECT_ID } from "./support";

async function setup() {
  const { db, client } = await createEvalsDb();
  const experiment = async (sandboxVersionId: string, state: "running" | "completed") => {
    const [row] = await db
      .insert(evalExperiments)
      .values({
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        sandboxVersionId,
        sandboxName: "support-agent",
        gitCommit: "b".repeat(40),
        gitDirty: false,
        params: {},
        trialsPerCase: 1,
        caseVersions: [],
        scorerSnapshots: {},
        startedBy: "user_1",
        state,
      })
      .returning({ id: evalExperiments.id });
    return row.id as string;
  };
  return { db, client, experiment, holds: createEvalSandboxVersionHolds(db) };
}

test("the version of a running experiment and of a pinned baseline are held, others are not", async () => {
  const t = await setup();
  const [running, pinned, done, unused] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await t.experiment(running, "running");
  const baseline = await t.experiment(pinned, "completed");
  await t.experiment(done, "completed");
  await t.client.query(
    "insert into eval_baselines (project_id, experiment_id, pinned_by, pinned_at) values ($1, $2, 'user_1', now())",
    [PROJECT_ID, baseline],
  );
  const held = await t.holds([running, pinned, done, unused]);
  assert.deepEqual([...held].sort(), [running, pinned].sort());
  assert.deepEqual([...(await t.holds([]))], []);
});
