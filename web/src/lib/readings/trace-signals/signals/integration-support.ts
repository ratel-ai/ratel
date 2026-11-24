import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { buildFixtureTurns, fixtureRows, type TurnFixture } from "@/lib/ledger/test-support";
import {
  countUnbuiltTurnEvents,
  getTraceTurnsCursor,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
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
import { recordOutcomes } from "@/lib/readings/trace-signals/outcomes/run";
import { outcomeRunDeps } from "@/lib/readings/trace-signals/outcomes/run-job";
import {
  loadErrorMessages,
  loadLastCalls,
  loadSessionTurns,
  loadTaskVerdicts,
  replaceSessionOutcomes,
  replaceTaskOutcomes,
  replaceTurnOutcomes,
  writeReplyReactions,
  writeTurnResults,
} from "@/lib/readings/trace-signals/outcomes/run-queries";
import {
  loadNextScopeReplies,
  loadSearchQueries,
  loadTurnReplies,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { recordSelfCorrections } from "@/lib/readings/trace-signals/self-corrections/run";
import { selfCorrectionRunDeps } from "@/lib/readings/trace-signals/self-corrections/run-job";
import {
  loadCorrectionPageFacts,
  loadTopicNames,
  replaceSelfCorrections,
} from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { loadSetupCounts } from "@/lib/readings/trace-signals/setup-facts-query";
import {
  loadAnalysisContext,
  loadCatalogNames,
  loadRunBasisCounts,
} from "@/lib/readings/trace-signals/signals/analysis-context";
import { computeSignals } from "@/lib/readings/trace-signals/signals/compute";
import {
  type ComputeJobDeps,
  UNBUILT_COUNT_CAP,
} from "@/lib/readings/trace-signals/signals/compute-job";
import { linkRunsPage } from "@/lib/readings/trace-signals/signals/linked-runs-query";
import {
  failSignalRun,
  latestSignalRun,
  persistSignalRun,
  reapStaleSignalRuns,
  startSignalRun,
} from "@/lib/readings/trace-signals/signals/queries";
import { writeTaskPlacement } from "@/lib/readings/trace-signals/workflows/place-queries";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * PGlite scaffolding shared by the signal integration tests: a migrated database with one
 * organization and project, a ledger seeded from turn fixtures (turns, steps and the
 * `trace_events` rows they point at), and the compute job's deps bound to that database.
 *
 * Owned (ADR-0004): organizations carry no plan column here (the limits come from the
 * entitlements port), and the deps have no feature flag and no tool-explorer enqueue.
 */

export const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

export type Db = ReturnType<typeof getDb>;

export async function setupDb(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

/**
 * Writes the fixtures' `trace_events` rows and their built (closed) turns into the
 * ledger, and sets the build cursor as a build would.
 */
export async function seedLedger(
  client: PGlite,
  db: Db,
  fixtures: readonly TurnFixture[],
): Promise<void> {
  const { rows } = fixtureRows(fixtures);
  for (const row of rows) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id,
         tool_id, query, trace_id, payload)
       values ($1, $2, $3, $4, $5, $6, $10, $7, $8, $9, '{}'::jsonb)`,
      [
        row.id,
        PROJECT_ID,
        row.type,
        row.sessionId,
        row.occurredAt?.toISOString() ?? null,
        row.receivedAt.toISOString(),
        row.toolId,
        row.query,
        row.traceId,
        row.id,
      ],
    );
  }
  const turns = buildFixtureTurns(fixtures);
  const through = new Date(Math.max(...rows.map((r) => r.receivedAt.getTime()))).toISOString();
  await writeTurnPage(
    { projectId: PROJECT_ID, turns, orphanedTurnIds: [], through, now: new Date() },
    db,
  );
}

export interface Tracked {
  event: string;
  properties: Record<string, unknown>;
}

export function jobDeps(
  db: Db,
  now: Date,
  tracked: Tracked[] = [],
  over: Partial<ComputeJobDeps> = {},
): Partial<ComputeJobDeps> {
  return {
    getOrganizationByProjectId: async () => {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, ORGANIZATION_ID));
      return org ?? null;
    },
    getCursor: (p) => getTraceTurnsCursor(p, db),
    latestRun: (p, _db, status) => latestSignalRun(p, db, status),
    reapStale: (p, before, _db, at) => reapStaleSignalRuns(p, before, db, at),
    startRun: (input, _db, at) => startSignalRun(input, db, at),
    failRun: (id, error, _db, at) => failSignalRun(id, error, db, at),
    persist: (input) => persistSignalRun(input, db),
    compute: (projectId, window, options) =>
      computeSignals(projectId, window, {
        ...options,
        listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
        loadContext: (p, w) => loadAnalysisContext(p, w, db),
        linkPage: (p, turns) => linkRunsPage(p, turns, db),
      }),
    loadSetupCounts: (p, w) => loadSetupCounts(p, w, db),
    enqueueLabels: async () => null,
    canLabel: () => false,
    countUnbuilt: (p, since) => countUnbuiltTurnEvents(p, since, UNBUILT_COUNT_CAP, db),
    writePlacement: (p, input) => writeTaskPlacement(p, input, db),
    recordSelfCorrections: (projectId, input, budget) =>
      recordSelfCorrections(projectId, input, {
        ...selfCorrectionRunDeps(budget),
        listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
        loadBasis: async (p, w) => chooseRunBasis(await loadRunBasisCounts(p, w, db)),
        loadPageFacts: (p, turns) => loadCorrectionPageFacts(p, turns, db),
        loadTopicNames: (p) => loadTopicNames(p, db),
        replaceRows: (p, range, rows) => replaceSelfCorrections(p, range, rows, db),
      }),
    recordHallucinations: (projectId, input, budget) =>
      recordHallucinations(projectId, input, {
        ...hallucinationRunDeps(budget),
        // On in the suite: the flag is a deployment's switch, not what these tests are about.
        enabled: async () => true,
        listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
        loadBasis: async (p, w) => chooseRunBasis(await loadRunBasisCounts(p, w, db)),
        loadCallFacts: (p, ids) => loadCallFacts(p, ids, db),
        loadCatalog: (p) => loadCatalogIdentities(p, (id) => loadCatalogNames(id, db)),
        loadReplyTexts: (p, turns) => loadTurnReplies(p, turns, db),
        loadFalseSuccessTurns: (p, range) => loadFalseSuccessTurns(p, range, db),
        replaceRows: (p, range, rows) => replaceHallucinations(p, range, rows, db),
      }),
    // The topic and explorer readings are their own jobs with their own tests; here no
    // enqueue reaches a real database.
    // Owned: the suite reads outcomes whatever the deployment's `sentimentAnalysis` switch says;
    // `outcomes/switch.integration.test.ts` runs the job with it off and on.
    outcomesEnabled: async () => true,
    recordOutcomes: (projectId, input, budget) =>
      recordOutcomes(projectId, input, {
        // Rule-only: the suite asks no model, whatever the environment holds.
        ...outcomeRunDeps(budget, null),
        listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
        loadBasis: async (p, w) => chooseRunBasis(await loadRunBasisCounts(p, w, db)),
        loadErrors: (p, ids) => loadErrorMessages(p, ids, db),
        loadSearchQueries: (p, ids) => loadSearchQueries(p, ids, db),
        loadLastCalls: (p, ids) => loadLastCalls(p, ids, db),
        replaceTurnRows: (p, range, rows, at) => replaceTurnOutcomes(p, range, rows, at, db),
        loadSessionTurns: (p, ids) => loadSessionTurns(p, ids, db),
        replaceSessionRows: (p, ids, rows, at) => replaceSessionOutcomes(p, ids, rows, at, db),
        loadTaskVerdicts: (p, ids) => loadTaskVerdicts(p, ids, db),
        replaceTaskRows: (p, ids, rows, at) => replaceTaskOutcomes(p, ids, rows, at, db),
        loadReplyTexts: (p, turns) => loadTurnReplies(p, turns, db),
        loadNextScopeReplies: (p, turns) => loadNextScopeReplies(p, turns, db),
        writeReplyReactions: (p, rows) => writeReplyReactions(p, rows, db),
        writeTurnResults: (p, rows) => writeTurnResults(p, rows, db),
      }),
    enqueueTopics: async () => null,
    enqueueTaskScores: async () => null,
    enqueueExplore: async () => null,
    importRunning: async () => false,
    enqueueFullReading: async () => null,
    storeHealthScore: async () => undefined,
    observability: {
      trackSystemEvent: async (event, _id, properties) => {
        tracked.push({ event, properties });
      },
    },
    now: () => now,
    ...over,
  };
}

export async function count(client: PGlite, sql: string): Promise<number> {
  const result = await client.query<{ n: number }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}
