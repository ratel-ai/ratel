import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import type { NewExperiment } from "../ports/experiment-store";
import { createEvalsDb, ORGANIZATION_ID, PROJECT_ID, seedEval } from "./support";

function experiment(evalId: string | null): NewExperiment {
  return {
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    evalId,
    datasetId: null,
    variants: [],
    changes: {},
    sandboxVersionId: "66666666-6666-4666-8666-666666666666",
    sandboxName: "support-demo",
    name: null,
    labelFilter: null,
    gitCommit: "",
    gitDirty: false,
    params: {},
    trialsPerCase: 1,
    caseVersions: [],
    evalVersions: [],
    scorerSnapshots: {},
    startedBy: "u",
  };
}

test("the runs of one eval are its own runs and the suite runs from before, not the newest of the project", async () => {
  const { db } = await createEvalsDb();
  const store = createDrizzleExperimentStore(db);
  const quiet = await seedEval(db, { name: "Quiet" });
  const busy = await seedEval(db, { name: "Busy" });
  const own = await store.create(experiment(quiet.id), 1_000);
  const suite = await store.create(experiment(null), 1_000);
  for (let index = 0; index < 5; index++) await store.create(experiment(busy.id), 1_000);
  assert.ok(own && suite);
  // The newest 3 runs of the project are all of the busy eval.
  assert.equal(
    (await store.list(PROJECT_ID, 3)).every(({ evalId }) => evalId === busy.id),
    true,
  );
  const ofQuiet = await store.list(PROJECT_ID, 3, { evalId: quiet.id });
  assert.deepEqual(ofQuiet.map(({ id }) => id).sort(), [own.id, suite.id].sort());
});
