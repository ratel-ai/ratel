import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { composition } from "@/lib/composition/ports";
import type { AnalysisFilterPort } from "@/lib/contracts/analysis-filter";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import {
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import { loadInferredToolShare } from "@/lib/readings/trace-signals/inferred-tools-query";
import { loadPartialFacts } from "@/lib/readings/trace-signals/partial-reading-query";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import {
  countCapturedSearches,
  countCapturedSearchesPerWindow,
  listSearchTelemetryProjects,
  loadSearchSelections,
} from "@/lib/synthesis/match-quality/search-source";

/**
 * Every analysis query over real PGlite, with the edition filtering the trace "skipped" and
 * without a filter: the traces "kept" and "skipped", and a search of no trace.
 */

const NOW = new Date();
const AT = new Date(NOW.getTime() - 3_600_000);
const WINDOW = { since: new Date(NOW.getTime() - 86_400_000), until: NOW };

const skipping: AnalysisFilterPort = {
  // Correlated on the project, as an edition's lookup is: it also proves both project forms.
  analyzedTraceCondition: async (projectId, traceId) => {
    const project = typeof projectId === "string" ? sql`${projectId}::uuid` : projectId;
    return sql`not exists (
      select 1 from projects p where p.id = ${project} and ${traceId} = 'skipped'
    )`;
  },
};

async function withFilter<T>(filter: AnalysisFilterPort, run: () => Promise<T>): Promise<T> {
  const before = composition.analysisFilter;
  composition.analysisFilter = filter;
  try {
    return await run();
  } finally {
    composition.analysisFilter = before;
  }
}

async function seed() {
  const { client, db } = await setupDb();
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const event = (n: number, traceId: string | null) => ({
    id: id(n),
    projectId: PROJECT_ID,
    type: "search",
    clientEventId: `e${n}`,
    sessionId: `s${n}`,
    traceId,
    query: "refund an order",
    occurredAt: AT,
    receivedAt: new Date(AT.getTime() + n),
    payload: {},
  });
  await db.insert(traceEvents).values([event(1, "kept"), event(2, null), event(3, "skipped")]);
  const span = (n: number, trace: string) =>
    `('${id(n)}', '${PROJECT_ID}', '${trace}', 'sp${n}', 'run', 1, 'tool', '${AT.toISOString()}',
      '${AT.toISOString()}', 10, 1, 'execute_tool', '{}'::jsonb)`;
  await client.exec(`
    insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at,
      ended_at, duration_ms, status_code, operation_name, attributes)
    values ${span(4, "kept")}, ${span(5, "skipped")}`);
  return { client, db };
}

type Db = Awaited<ReturnType<typeof seed>>["db"];

async function read(db: Db) {
  const options = { now: NOW, windowDays: 7 } as const;
  return {
    inferred: (await loadInferredToolShare(PROJECT_ID, options, db)).toolSpans,
    partial: (await loadPartialFacts(PROJECT_ID, options, db)).runs,
    searches: await countCapturedSearches(PROJECT_ID, WINDOW, db),
    perWindow: (await countCapturedSearchesPerWindow(PROJECT_ID, [7], db)).counts.get(7),
    projects: (await listSearchTelemetryProjects(WINDOW, db)).length,
    selections: (await loadSearchSelections(PROJECT_ID, WINDOW, db)).selections.length,
    page: (await listTurnEventsPage(PROJECT_ID, new Date(0), db)).map((row) => [
      row.traceId,
      row.analysisSkipped,
    ]),
  };
}

test("the default filter reads every trace", async () => {
  const { client, db } = await seed();
  assert.deepEqual(await read(db), {
    inferred: 2,
    partial: 2,
    searches: 3,
    perWindow: 3,
    projects: 1,
    selections: 3,
    page: [
      ["kept", false],
      [null, false],
      ["skipped", false],
    ],
  });
  await client.close();
});

test("an edition's filter keeps every query off a skipped trace", async () => {
  const { client, db } = await seed();
  assert.deepEqual(await withFilter(skipping, () => read(db)), {
    inferred: 1,
    partial: 1,
    searches: 2,
    perWindow: 2,
    projects: 1,
    selections: 2,
    page: [
      ["kept", false],
      [null, false],
      ["skipped", true],
    ],
  });
  await db.delete(traceEvents).where(sql`trace_id is distinct from 'skipped'`);
  assert.equal((await withFilter(skipping, () => read(db))).projects, 0);
  await client.close();
});

test("the turn build skips the trace and still moves its cursor past it", async () => {
  const { client, db } = await seed();
  const result = await withFilter(skipping, () =>
    buildProjectTraceTurns(PROJECT_ID, {
      readsAgentRuns: async () => false,
      getCursor: (p) => getTraceTurnsCursor(p, db),
      listEvents: (p, since, _db, limit) => listTurnEventsPage(p, since, db, limit),
      listHits: (ids) => listTurnEventHits(ids, db),
      loadTurns: (p, sessions, keys, reach) => loadReloadableTurns(p, sessions, keys, reach, db),
      writePage: (input) => writeTurnPage(input, db),
      closeIdle: async () => 0,
      enqueueBuild: async () => null,
      observability: { trackSystemEvent: async () => {} },
      salt: "test-salt",
    }),
  );
  assert.equal(result.events, 2);
  assert.equal(result.turnsWritten, 2);
  const last = new Date(AT.getTime() + 3);
  assert.equal((await getTraceTurnsCursor(PROJECT_ID, db))?.at.getTime(), last.getTime());
  await client.close();
});
