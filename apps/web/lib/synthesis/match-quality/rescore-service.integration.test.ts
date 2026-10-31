import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import { matchQualityRuns } from "@/lib/synthesis/match-quality/schema";
import { catalogFingerprints } from "@/lib/synthesis/quality/schema";
import type { ProposalInsert } from "./queries";
import { insertEvalItems, listProposals, replacePendingProposals, startRun } from "./queries";
import { REPLAY_CREDIT } from "./replay";
import { rescoreStaleBacktests } from "./rescore-service";
import type { EvalItem } from "./types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-14T12:00:00Z");

/** Written before the credit marker existed: no `credit` field at all. */
const OLD_BLOB = { scorer: "bm25-replay", n: 1, discarded: 2 };

const ITEMS: EvalItem[] = [
  {
    selectionId: "sel-1",
    occurredAt: NOW,
    query: "refund a payment",
    targetEntryId: "ledger_op",
    targetKind: "tool",
    targetSource: "judge",
    arms: [
      { arm: "ratel", role: "shadow", resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "serving", resultIds: ["ledger_op"], resultScores: null },
    ],
  },
];

async function seeded() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await db.insert(projects).values({ id: PROJECT, organizationId: ORG, name: "P", slug: "p" });
  await db.insert(runtimeCatalogEntries).values(
    [
      ["ledger_op", "Handles ledger reversal operations."],
      ["list_invoices", "Lists invoices for an account."],
    ].map(([entryId, searchable]) => ({
      projectId: PROJECT,
      kind: "tool",
      entryId,
      name: entryId,
      description: searchable,
      tags: [],
      searchableDescription: searchable,
      searchableDescriptionOverridden: false,
      useCloudDefinitions: false,
      searchableDescriptionOverride: null,
      contentHash: `h-${entryId}`,
    })),
  );

  const run = await startRun(
    {
      projectId: PROJECT,
      experimentName: "exp",
      trigger: "manual",
      windowDays: 7,
      windowStart: NOW,
      windowEnd: NOW,
    },
    db,
    NOW,
  );
  assert.ok(run);
  await insertEvalItems(run.id, PROJECT, ITEMS, db);
  const insert: ProposalInsert = {
    proposal: {
      entryId: "ledger_op",
      searchableDescription: "Refund a payment. Handles ledger reversal operations.",
      rationale: "r",
      details: "d",
      expectedEffect: "e",
    },
    entry: {
      entryId: "ledger_op",
      name: "ledger_op",
      searchable: "Handles ledger reversal operations.",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
    preview: {
      scorer: "bm25-spotcheck",
      hits: [],
      improved: 0,
      worsened: 0,
      unchanged: 0,
      reproductionRate: null,
      reproductionSample: 0,
      inconclusive: true,
    },
    evidence: {},
    backtest: OLD_BLOB as never,
  };
  await replacePendingProposals(run.id, PROJECT, [insert], db, NOW);
  await db
    .update(matchQualityRuns)
    .set({ status: "analyzed", tunedArm: "ratel", baselineArm: "legacy", backtest: OLD_BLOB })
    .where(eq(matchQualityRuns.id, run.id));

  return { client, db, runId: run.id };
}

async function storedRunBacktest(db: Awaited<ReturnType<typeof seeded>>["db"], runId: string) {
  const [run] = await db
    .select({ backtest: matchQualityRuns.backtest })
    .from(matchQualityRuns)
    .where(eq(matchQualityRuns.id, runId));
  return run.backtest as Record<string, unknown>;
}

test("a dry run reports old and new figures and writes nothing", async (t) => {
  const { client, db, runId } = await seeded();
  t.after(() => client.close());

  const report = await rescoreStaleBacktests({ db });
  assert.equal(report.applied, false);
  assert.equal(report.runs.length, 1);
  const [run] = report.runs;
  assert.equal(run.runId, runId);
  // The old blob carried no scores; the new one does.
  assert.equal(run.corpusSource, "today");
  assert.deepEqual(run.old, {
    n: 1,
    containmentBefore: null,
    containmentAfter: null,
    qualityBefore: null,
    qualityAfter: null,
  });
  assert.equal(run.new?.containmentBefore, 0);
  assert.equal(run.new?.containmentAfter, 1);
  assert.equal(run.proposals.length, 1);
  assert.equal(run.proposals[0].entryId, "ledger_op");

  assert.deepEqual(await storedRunBacktest(db, runId), OLD_BLOB);
});

test("--apply writes the current curve, once", async (t) => {
  const { client, db, runId } = await seeded();
  t.after(() => client.close());

  const first = await rescoreStaleBacktests({ db, apply: true });
  assert.equal(first.runs.length, 1);

  const blob = await storedRunBacktest(db, runId);
  assert.equal(blob.credit, REPLAY_CREDIT);
  assert.equal(blob.discarded, 2);

  const [proposal] = await listProposals(PROJECT, { runId }, db);
  assert.equal((proposal.backtest as Record<string, unknown>).credit, REPLAY_CREDIT);

  // Nothing is stale any more, so a second pass finds nothing.
  const second = await rescoreStaleBacktests({ db, apply: true });
  assert.equal(second.runs.length, 0);
});

test("--project restricts the pass to one project", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const other = await rescoreStaleBacktests({
    db,
    projectId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(other.runs.length, 0);
});

test("a run is replayed against its own stored catalog and its own history", async (t) => {
  const { client, db, runId } = await seeded();
  t.after(() => client.close());

  // The catalog as the run saw it: ledger_op already said "refund a payment".
  await db.insert(catalogFingerprints).values({
    projectId: PROJECT,
    fingerprint: "fp-at-run",
    entryCount: 2,
    searchableChars: 0,
    overriddenCount: 0,
    distinctCount: 0,
    entries: [
      { kind: "tool", entryId: "ledger_op", name: "ledger_op", searchable: "Refund a payment." },
      {
        kind: "tool",
        entryId: "list_invoices",
        name: "list_invoices",
        searchable: "Lists invoices.",
      },
    ],
  });
  await db
    .update(matchQualityRuns)
    .set({ corpusFingerprint: "fp-at-run" })
    .where(eq(matchQualityRuns.id, runId));

  // A LATER run's items must not leak into this run's replay.
  const later = await startRun(
    {
      projectId: PROJECT,
      experimentName: "exp",
      trigger: "manual",
      windowDays: 7,
      windowStart: NOW,
      windowEnd: NOW,
    },
    db,
    new Date(NOW.getTime() + 60_000),
  );
  assert.ok(later);
  await db
    .update(matchQualityRuns)
    .set({ createdAt: new Date(NOW.getTime() + 86_400_000), status: "analyzed" })
    .where(eq(matchQualityRuns.id, later.id));
  await insertEvalItems(
    later.id,
    PROJECT,
    [{ ...ITEMS[0], selectionId: "sel-later", query: "a later ask" }],
    db,
  );

  const report = await rescoreStaleBacktests({ db, projectId: PROJECT });
  const run = report.runs.find((row) => row.runId === runId)!;
  assert.equal(run.corpusSource, "run");
  assert.equal(run.new?.n, 1);
  // Against the run's catalog the target was already found before the patch.
  assert.equal(run.new?.containmentBefore, 1);
});
