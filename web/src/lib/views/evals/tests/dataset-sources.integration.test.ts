import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatasetSources } from "../adapters/dataset-sources";
import { createEvalsDb, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

/** The reads of a query dataset read the closed turns of one project only. */

const turn = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function setup() {
  const { client, db } = await createEvalsDb();
  const insert = (
    id: string,
    projectId: string,
    minute: number,
    over: { key?: string; status?: string; task?: string | null; errors?: number } = {},
  ) =>
    client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status,
         started_at, ended_at, last_received_at, workflow_id, error_count)
       values ($1, $2, 's', $3, 'otlp', 'otlp', $4, $5, $5, $5, $6, $7)`,
      [
        id,
        projectId,
        over.key ?? `otlp:${id.replaceAll("-", "")}`,
        over.status ?? "closed",
        new Date(Date.UTC(2026, 10, 27, 10, minute)),
        over.task ?? null,
        over.errors ?? 0,
      ],
    );
  await insert(turn(1), PROJECT_ID, 1, { task: "wf-a", key: "otlp:trace1" });
  await insert(turn(2), PROJECT_ID, 2, { task: "wf-b", errors: 2, key: "otlp:trace2" });
  await insert(turn(3), PROJECT_ID, 3, { status: "open" });
  await insert(turn(4), OTHER_PROJECT_ID, 4, { task: "wf-a", key: "otlp:trace4" });
  return createDatasetSources(db);
}

test("the newest closed turns and the turns of a task are of the project", async () => {
  const sources = await setup();
  assert.deepEqual(await sources.newestTurns(PROJECT_ID, 10), [turn(2), turn(1)]);
  assert.deepEqual(await sources.newestTurns(PROJECT_ID, 1), [turn(2)]);
  assert.deepEqual(await sources.taskTurns(PROJECT_ID, "wf-a", 10), [turn(1)]);
  assert.deepEqual(await sources.taskTurns(OTHER_PROJECT_ID, "wf-a", 10), [turn(4)]);
});

test("the turns of traces are found by trace id in the project only, in the order of the traces", async () => {
  const sources = await setup();
  assert.deepEqual(await sources.turnsOfTraces(PROJECT_ID, ["TRACE2", "trace1", "trace4"]), [
    turn(2),
    turn(1),
  ]);
  assert.deepEqual(await sources.turnsOfTraces(PROJECT_ID, []), []);
});

test("the candidates of let Ratel choose know a failed turn", async () => {
  const sources = await setup();
  const candidates = await sources.chooseCandidates(PROJECT_ID, 10);
  assert.deepEqual(
    candidates.map(({ turnId, taskId, failed, score }) => [turnId, taskId, failed, score]),
    [
      [turn(2), "wf-b", true, null],
      [turn(1), "wf-a", false, null],
    ],
  );
});
