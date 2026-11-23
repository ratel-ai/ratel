import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { resolveConfig } from "@/config";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { hallucinationReadingEnabled } from "@/lib/readings/trace-signals/hallucinations/gate";
import { recordHallucinations } from "@/lib/readings/trace-signals/hallucinations/run";
import {
  hallucinationRunDeps,
  loadCatalogIdentities,
} from "@/lib/readings/trace-signals/hallucinations/run-job";
import {
  loadCallFacts,
  loadFalseSuccessTurns,
  replaceHallucinations,
} from "@/lib/readings/trace-signals/hallucinations/run-queries";
import { loadTurnReplies } from "@/lib/readings/trace-signals/outcomes/text-queries";
import {
  loadCatalogNames,
  loadRunBasisCounts,
} from "@/lib/readings/trace-signals/signals/analysis-context";
import {
  type ComputeJobDeps,
  computeProjectTraceSignals,
} from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * The signal run behind the core's `hallucinationDetection` switch (ADR-0004; not an upstream
 * file: upstream's integration test stands in for the switch with a reading that returns null).
 * Here the reading is the real one behind the real gate, for a deployment with a given
 * environment and no edition: with `FF_HALLUCINATION_DETECTION` unset the run writes no row to
 * `trace_hallucinations` and leaves no hallucinations in its summary; set, it writes them.
 */

const BASE = Date.parse("2026-09-10T08:00:00Z");
const NOW = new Date("2026-09-11T08:00:00Z");

/**
 * 12 sessions of one run each: four ran `entity_lookup` where the agent asked for `get_task`
 * (under the five calls that would make the pair a learned alias).
 */
function fixtures() {
  return times(12, (i) => {
    const run = fresh({ session: `s-${i.toString().padStart(2, "0")}`, start: BASE + i * 60_000 });
    return i < 4 ? run.invoke("entity_lookup") : run.invoke("find_task").invoke("list_tasks");
  });
}

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await client.query(
    `update trace_events set payload = payload || jsonb_build_object('requested_tool_id', 'get_task') where tool_id = 'entity_lookup'`,
  );
  return { client, db };
}

/** The switch as the job reads it, for a deployment with this environment and no edition. */
const switchFor = (env: Record<string, string>) => (projectId: string) =>
  hallucinationReadingEnabled(projectId, {
    getOrganization: async () => ({ id: ORGANIZATION_ID }),
    flags: { config: resolveConfig({ env }), edition: "Ratel OSS", port: undefined },
  });

/** The job's own reading against the test database, behind `enabled`. */
function reading(
  db: Db,
  enabled: (projectId: string) => Promise<boolean>,
): NonNullable<ComputeJobDeps["recordHallucinations"]> {
  return (projectId, input, budget) =>
    recordHallucinations(projectId, input, {
      ...hallucinationRunDeps(budget),
      enabled,
      listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
      loadBasis: async (p, w) => chooseRunBasis(await loadRunBasisCounts(p, w, db)),
      loadCallFacts: (p, ids) => loadCallFacts(p, ids, db),
      loadCatalog: (p) => loadCatalogIdentities(p, (id) => loadCatalogNames(id, db)),
      loadReplyTexts: (p, turns) => loadTurnReplies(p, turns, db),
      loadFalseSuccessTurns: (p, range) => loadFalseSuccessTurns(p, range, db),
      replaceRows: (p, range, rows) => replaceHallucinations(p, range, rows, db),
    });
}

const rowCount = (client: PGlite) =>
  count(client, `select count(*)::int as n from trace_hallucinations`);

test("FF_HALLUCINATION_DETECTION unset: the run completes and writes no hallucination row", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], { recordHallucinations: reading(db, switchFor({})) }),
  );
  assert.equal(result.outcome, "completed");
  assert.equal(await rowCount(client), 0);
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.equal("hallucinations" in ((run?.summary ?? {}) as object), false);
});

test("FF_HALLUCINATION_DETECTION=0 is off too, and a switch that cannot be read is off", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], {
      recordHallucinations: reading(db, switchFor({ FF_HALLUCINATION_DETECTION: "0" })),
    }),
  );
  assert.equal(await rowCount(client), 0);
  const failing = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 60_000), [], {
      recordHallucinations: reading(db, async () => {
        throw new Error("flags down");
      }),
    }),
  );
  assert.equal(failing.outcome, "completed");
  assert.equal(await rowCount(client), 0);
});

test("FF_HALLUCINATION_DETECTION=1: the run writes a row per finding and its counts", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], {
      recordHallucinations: reading(db, switchFor({ FF_HALLUCINATION_DETECTION: "1" })),
    }),
  );
  assert.equal(result.outcome, "completed");
  assert.equal(await rowCount(client), 4);
  const run = await latestSignalRun(PROJECT_ID, db);
  const stored = (
    run?.summary as {
      hallucinations?: { turns: number; findings: number; byKind: Record<string, number> };
    }
  ).hallucinations;
  assert.deepEqual([stored?.turns, stored?.findings, stored?.byKind.tool_rerouted], [12, 4, 4]);
});
