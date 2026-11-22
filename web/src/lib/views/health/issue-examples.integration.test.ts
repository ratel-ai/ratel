import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { readIssueExamples } from "@/lib/views/health/issue-examples";

const NOW = new Date("2026-09-02T00:00:00Z");
const OTHER = "99999999-9999-4999-8999-999999999999";

async function project() {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    ...times(130, () =>
      fresh()
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
    ),
    ...times(25, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const open = await listOpenSignals(PROJECT_ID, db);
  assert.ok(open.length >= 2, "the run raised issues to read");
  return { db, open };
}

test("an opened issue reads its own turns, with the search the user typed, for the plan's issues only", async () => {
  const { db, open } = await project();
  const [worst, next] = open;
  const read = await readIssueExamples(db, PROJECT_ID, [worst!.id, next!.id, OTHER], {
    perIssue: 3,
    shown: Infinity,
  });
  assert.deepEqual(
    read.map((entry) => entry.id),
    [worst!.id, next!.id],
    "an id that is not one of the project's open issues reads as nothing",
  );
  for (const entry of read) {
    assert.ok(entry.turns.length > 0 && entry.turns.length <= 3, "cut to the plan's turns");
    assert.ok(entry.total >= entry.turns.length);
  }
  const queries = read.flatMap((entry) =>
    entry.turns.flatMap((turn) =>
      turn.steps.flatMap((step) =>
        step.kind === "search" && step.query.state === "captured" ? [step.query.text] : [],
      ),
    ),
  );
  assert.ok(queries.includes("find my open tasks"), "the words are read live, on demand");

  const cut = await readIssueExamples(db, PROJECT_ID, [worst!.id, next!.id], {
    perIssue: 1,
    shown: 1,
  });
  assert.deepEqual(
    cut.map((entry) => entry.id),
    [worst!.id],
    "an issue past the plan's cut is not read",
  );
  assert.equal(cut[0]!.turns.length, 1);

  assert.deepEqual(
    await readIssueExamples(db, OTHER, [worst!.id], { perIssue: 3, shown: Infinity }),
    [],
    "another project reads nothing",
  );
});
