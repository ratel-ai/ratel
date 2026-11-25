import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadSessionFindings } from "@/lib/views/health/hallucinations/session-bookmarks";
import { replayFocus } from "@/lib/views/traces/turn-view";

const BASE = Date.parse("2026-09-01T09:00:00Z");

test("a session's findings come with the event of the call they sit on, and no other session's", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    fresh({ session: "s-1", start: BASE }).invoke("update_task").error("update_task"),
    fresh({ session: "s-2", start: BASE + 60_000 })
      .invoke("update_task")
      .error("update_task"),
  ]);
  await client.query(
    `insert into trace_hallucinations (project_id, turn_id, step_ordinal, kind, tool_id, evidence, repeats, worked, rule_version, occurred_at)
     select project_id, id, 1, 'unknown_reference', 'update_task', 'entity_not_found', 1, false, 2, ended_at from trace_turns`,
  );
  const found = await loadSessionFindings(db as never, PROJECT_ID, "s-1");
  const step = await client.query<{ id: string }>(
    `select s.trace_event_id as id from trace_turn_steps s join trace_turns t on t.id = s.turn_id where t.session_id = 's-1' and s.ordinal = 1`,
  );
  assert.deepEqual(found, [
    { eventId: step.rows[0]?.id, kind: "unknown_reference", toolId: "update_task" },
  ]);
});

test("the replay opens on the focused call when it is marked, else on the turn's first marked call", () => {
  const turn = {
    calls: [1, 2, 3].map((ordinal) => ({ ordinal, eventId: `e-${ordinal}` })),
  } as never;
  assert.equal(replayFocus(turn, [{ stepOrdinal: 2 }, { stepOrdinal: 3 }], "e-3"), "e-3");
  assert.equal(replayFocus(turn, [{ stepOrdinal: 2 }], "e-1"), "e-2");
  assert.equal(replayFocus(turn, [], "e-1"), null);
});
