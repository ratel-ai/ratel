import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { TimeBudgetError } from "@/lib/ledger/turn-pages";
import { HALLUCINATION_RULE_VERSION } from "@/lib/readings/trace-signals/hallucinations/kinds";
import { recordHallucinations } from "@/lib/readings/trace-signals/hallucinations/run";
import { hallucinationRunDeps } from "@/lib/readings/trace-signals/hallucinations/run-job";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * One signal run over a migrated database: the window's hallucinations are
 * written from the ledger, the calls' error text and the tool each call asked
 * for; the counts land in the run summary; no message reaches a row; a second
 * run gives the same rows; with the switch off nothing is written. Every
 * message here is invented.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");

/**
 * 12 sessions of one run each. 0-3: asked for `get_task`, ran `entity_lookup`
 * (worked). 4-5: asked for `get_document`, ran `create_document` (failed
 * twice). 6-8: `update_task` fails on a task that does not exist. 9: a value
 * `update_task` does not take. 10: a bare validation error. 11: clean.
 */
function fixtures() {
  return times(12, (i) => {
    const run = fresh({ session: `s-${i.toString().padStart(2, "0")}`, start: BASE + i * 60_000 });
    if (i < 4) return run.invoke("entity_lookup");
    if (i < 6)
      return run
        .invoke("create_document")
        .error("create_document")
        .invoke("create_document")
        .error("create_document");
    if (i < 9) return run.invoke("update_task").error("update_task");
    if (i === 9) return run.invoke("set_status").error("set_status");
    if (i === 10) return run.invoke("filter_tasks").error("filter_tasks");
    return run.invoke("find_task").invoke("list_tasks");
  });
}

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  // The SDK sends `requested_tool_id` on a call's events when it differs from the tool that ran.
  await client.query(
    `update trace_events set payload = payload || jsonb_build_object('requested_tool_id', 'get_task') where tool_id = 'entity_lookup'`,
  );
  await client.query(
    `update trace_events set payload = payload || jsonb_build_object('requested_tool_id', 'get_document') where tool_id = 'create_document'`,
  );
  await client.query(
    `update trace_events set error_message = 'validation_failed' where type = 'invoke_error' and tool_id in ('create_document', 'filter_tasks')`,
  );
  await client.query(
    `update trace_events set error_message = 'Task not found' where type = 'invoke_error' and tool_id = 'update_task'`,
  );
  // A replayed dump keeps the message in the payload.
  await client.query(
    `update trace_events set payload = payload || jsonb_build_object('error', 'Invalid status. Available: To Do (a1), Done (b2)') where type = 'invoke_error' and tool_id = 'set_status'`,
  );
  return { client, db };
}

interface Row {
  session_id: string;
  kind: string;
  tool_id: string;
  requested_tool_id: string | null;
  evidence: string;
  repeats: number;
  worked: boolean;
  step_ordinal: number;
  rule_version: number;
}

async function rowsOf(client: PGlite): Promise<Row[]> {
  const result = await client.query<Row>(
    `select t.session_id, h.kind, h.tool_id, h.requested_tool_id, h.evidence, h.repeats, h.worked, h.step_ordinal, h.rule_version
       from trace_hallucinations h join trace_turns t on t.id = h.turn_id
      where h.project_id = '${PROJECT_ID}' order by t.session_id, h.step_ordinal, h.kind`,
  );
  return result.rows;
}

test("a run writes the window's hallucinations and their counts into the run summary", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");

  const rows = await rowsOf(client);
  assert.deepEqual(
    rows.map((row) => [
      row.session_id,
      row.kind,
      row.tool_id,
      row.requested_tool_id,
      row.evidence,
      row.repeats,
      row.worked,
    ]),
    [
      ...["s-00", "s-01", "s-02", "s-03"].map((session) => [
        session,
        "tool_rerouted",
        "entity_lookup",
        "get_task",
        "requested_differs",
        1,
        true,
      ]),
      // A read that ran as a create, twice, and failed: one finding, and its validation error is not a second one.
      ...["s-04", "s-05"].map((session) => [
        session,
        "tool_action_changed",
        "create_document",
        "get_document",
        "requested_differs",
        2,
        false,
      ]),
      ...["s-06", "s-07", "s-08"].map((session) => [
        session,
        "unknown_reference",
        "update_task",
        null,
        "entity_not_found",
        1,
        false,
      ]),
      ["s-09", "value_not_allowed", "set_status", null, "lists_allowed_values", 1, false],
    ],
  );
  assert.ok(
    rows.every((row) => row.rule_version === HALLUCINATION_RULE_VERSION && row.step_ordinal === 1),
  );

  const run = await latestSignalRun(PROJECT_ID, db);
  assert.deepEqual((run?.summary as { hallucinations?: unknown }).hallucinations, {
    turns: 12,
    turnsAffected: 10,
    findings: 10,
    byKind: {
      unknown_tool: 0,
      tool_rerouted: 4,
      tool_action_changed: 2,
      unknown_reference: 3,
      value_not_allowed: 1,
      claimed_done_after_failure: 0,
      done_but_person_says_not: 0,
    },
    aliases: [],
  });
});

test("no message text reaches a row, and a second run gives the same rows", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const first = await rowsOf(client);
  const stored = await client.query<{ row: string }>(
    `select to_jsonb(h)::text as row from trace_hallucinations h where project_id = '${PROJECT_ID}'`,
  );
  for (const { row } of stored.rows) {
    for (const words of ["not found", "Available", "validation_failed", "To Do"])
      assert.ok(!row.includes(words), `a row holds "${words}"`);
  }
  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 60_000)),
  );
  assert.deepEqual(await rowsOf(client), first);
});

test("with the switch off the run completes and the reading reads and writes nothing", async () => {
  const { client, db } = await seeded();
  const deps = jobDeps(db, NOW);
  const untouched = async (): Promise<never> => {
    throw new Error("nothing is read or written with the switch off");
  };
  // The reading itself, with its switch off: it must stop before its first read.
  // How the switch is read (the deployment's flag) is `switch.integration.test.ts`.
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    {
      ...deps,
      recordHallucinations: (projectId, input, budget) =>
        recordHallucinations(projectId, input, {
          ...hallucinationRunDeps(budget),
          enabled: async () => false,
          listPage: untouched,
          loadBasis: untouched,
          loadCallFacts: untouched,
          loadCatalog: untouched,
          loadReplyTexts: untouched,
          loadFalseSuccessTurns: untouched,
          replaceRows: untouched,
        }),
    },
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(await rowsOf(client), []);
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.equal((run?.summary as { hallucinations?: unknown }).hallucinations, undefined);
});

test("a reading that runs out of time marks the run partial and writes nothing", async () => {
  const { client, db } = await seeded();
  const deps = jobDeps(db, NOW);
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    {
      ...deps,
      recordHallucinations: async () => {
        throw new TimeBudgetError();
      },
    },
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(await rowsOf(client), []);
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.deepEqual((run?.summary as { hallucinations?: unknown }).hallucinations, {
    partial: true,
  });
});

test("findings read under older rules are gone after the next run, wherever they are", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const written = (await rowsOf(client)).length;
  assert.ok(written > 0);
  // As if one finding were written before the rules changed, on a turn this run will not read.
  await client.query(`update trace_hallucinations set rule_version = rule_version - 1`);
  await client.query(
    `update trace_turns set ended_at = ended_at - interval '400 days', started_at = started_at - interval '400 days'
      where id = (select turn_id from trace_hallucinations limit 1)`,
  );
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_hallucinations where rule_version < ${HALLUCINATION_RULE_VERSION}`,
    ),
    0,
  );
  assert.ok((await rowsOf(client)).length > 0, "the window's findings are read again");
});
