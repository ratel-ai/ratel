import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { HALLUCINATION_RULE_VERSION } from "@/lib/readings/trace-signals/hallucinations/kinds";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { countWindowTurns, loadPageFindings } from "@/lib/views/health/hallucinations/page-queries";
import { loadHallucinationRateCard } from "@/lib/views/health/hallucinations/rate-card";

/**
 * The rate on the Summary and the page's reads, against a database: what is
 * over what, which project's rows count, and the cap.
 */

const BASE = Date.parse("2026-09-01T09:00:00Z");
const NOW = new Date("2026-09-02T00:00:00Z");
const WINDOW = { from: new Date("2026-08-26T00:00:00Z"), to: NOW };
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

/** Ten closed turns, one per session, each with a failed call. */
async function seeded() {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(10, (i) =>
      fresh({ session: `s-${i}`, start: BASE + i * 60_000 })
        .invoke("update_task")
        .error("update_task"),
    ),
  );
  return { client, db };
}

/** A finding on each of these turns (by their order), in `project`. */
async function addFindings(
  client: PGlite,
  turns: number[],
  project = PROJECT_ID,
  kind = "unknown_reference",
) {
  const { rows } = await client.query<{ id: string; ended_at: Date }>(
    `select id, ended_at from trace_turns where project_id = $1 order by started_at`,
    [PROJECT_ID],
  );
  for (const at of turns) {
    const turn = rows[at]!;
    await client.query(
      `insert into trace_hallucinations (project_id, turn_id, step_ordinal, kind, tool_id, evidence, rule_version, occurred_at)
       values ($1, $2, 1, $3, 'update_task', 'entity_not_found', $4, $5)`,
      [project, turn.id, kind, HALLUCINATION_RULE_VERSION, turn.ended_at],
    );
  }
}

async function markRead(client: PGlite) {
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary, created_at)
     values ($1, 'manual', 'completed', 7, $2, $3, '{"hallucinations":{"findings":0,"aliases":[]}}', $3)`,
    [PROJECT_ID, WINDOW.from, NOW],
  );
}

test("the rate is turns with a finding over the window's closed turns, by group", async () => {
  const { client, db } = await seeded();
  await markRead(client);
  await addFindings(client, [0, 1, 1]);
  await addFindings(client, [2], PROJECT_ID, "unknown_tool");
  const card = await loadHallucinationRateCard(PROJECT_ID, 7, db as never, NOW);
  assert.equal(card.turns, 10);
  assert.equal(card.turnsAffected, 3, "two findings on one turn count it once");
  assert.equal(card.occurrences, 4);
  assert.equal(card.rate, 0.3);
  assert.deepEqual(
    card.groups.map((group) => [group.group, group.occurrences]),
    [
      ["tool", 1],
      ["input", 3],
      ["completion", 0],
    ],
  );
  assert.equal(card.href, `/project/${PROJECT_ID}/health/hallucinations?days=7`);
});

test("before the reading has run the rate is none, not 0%", async () => {
  const { db } = await seeded();
  const card = await loadHallucinationRateCard(PROJECT_ID, 7, db as never, NOW);
  assert.equal(card.read, false);
  assert.equal(card.rate, null);
});

test("a window with no turn has no rate, and another project's rows never count", async () => {
  const { client, db } = await seeded();
  await markRead(client);
  await client.query(
    `insert into projects (id, organization_id, name, slug)
     select $1, organization_id, 'Other', 'other' from projects where id = $2`,
    [OTHER_PROJECT, PROJECT_ID],
  );
  await addFindings(client, [0, 1, 2], OTHER_PROJECT);
  const card = await loadHallucinationRateCard(PROJECT_ID, 7, db as never, NOW);
  assert.equal(card.occurrences, 0);
  assert.equal(card.rate, 0);
  const page = await loadPageFindings(PROJECT_ID, WINDOW, db as never);
  assert.deepEqual(page.findings, []);

  const empty = await loadHallucinationRateCard(
    PROJECT_ID,
    7,
    db as never,
    new Date("2027-01-01T00:00:00Z"),
  );
  assert.equal(empty.turns, 0);
  assert.equal(empty.rate, null);
});

test("the page's findings are newest first, capped, and the turns it is over are the closed ones", async () => {
  const { client, db } = await seeded();
  await addFindings(client, [0, 1, 2, 3, 4]);
  const capped = await loadPageFindings(PROJECT_ID, WINDOW, db as never, 3);
  assert.equal(capped.capped, true);
  assert.equal(capped.findings.length, 3);
  const times = capped.findings.map((finding) => finding.occurredAt.getTime());
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
    "newest first",
  );
  assert.equal((await loadPageFindings(PROJECT_ID, WINDOW, db as never, 5)).capped, false);

  await client.query(
    `update trace_turns set status = 'open' where id = (select id from trace_turns order by started_at limit 1)`,
  );
  assert.equal(await countWindowTurns(PROJECT_ID, WINDOW, db as never), 9);
});
