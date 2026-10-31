import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { setRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-queries";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import { type ApplyDeps, applyProposal, applyProposals, revertProposal } from "./apply";
import type { ProposalInsert } from "./queries";
import {
  getProposal,
  listProposals,
  replacePendingProposals,
  startRun,
  swapRuntimeOverride,
  transitionProposal,
} from "./queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-14T12:00:00Z");

async function seeded(entries: Array<{ entryId: string; override: string | null }>) {
  const client = await createMigratedPGlite();
  // Cast once, here. PGlite and node-postgres expose an identical query surface
  // and differ only in the driver metadata on a result, so every `lib/` helper
  // works against this handle; casting at each of the forty call sites instead
  // would bury that fact in noise.
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await db.insert(projects).values({ id: PROJECT, organizationId: ORG, name: "P", slug: "p" });
  await db.insert(runtimeCatalogEntries).values(
    entries.map((entry) => ({
      projectId: PROJECT,
      kind: "tool",
      entryId: entry.entryId,
      name: entry.entryId,
      description: `Agent-facing text for ${entry.entryId}.`,
      tags: ["billing"],
      searchableDescription: `Runtime searchable text for ${entry.entryId}.`,
      searchableDescriptionOverridden: false,
      useCloudDefinitions: false,
      searchableDescriptionOverride: entry.override,
      contentHash: `h-${entry.entryId}`,
    })),
  );
  return { client, db };
}

/** The seeded PGlite handle, which drizzle types differently from node-postgres. */
type TestDb = Awaited<ReturnType<typeof seeded>>["db"];

function deps(db: TestDb): ApplyDeps {
  return {
    now: () => NOW,
    logError: () => {},
    getProposal: (projectId, proposalId) => getProposal(projectId, proposalId, db),
    swapOverride: (projectId, entryId, text) => swapRuntimeOverride(projectId, entryId, text, db),
    transitionProposal: (proposalId, from, to, extra) =>
      transitionProposal(proposalId, from, to, extra, db, NOW),
  };
}

function insert(entryId: string, text: string): ProposalInsert {
  return {
    proposal: {
      entryId,
      searchableDescription: text,
      rationale: "r",
      details: "d",
      expectedEffect: "e",
    },
    entry: {
      entryId,
      name: entryId,
      searchable: "old",
      source: "runtime",
      matchesAgentDescription: false,
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
  };
}

async function proposalsFor(db: TestDb, inserts: ProposalInsert[]) {
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
  await replacePendingProposals(run.id, PROJECT, inserts, db, NOW);
  return listProposals(PROJECT, { statuses: ["pending"] }, db);
}

async function overrideOf(db: TestDb, entryId: string) {
  const [row] = await db
    .select({ value: runtimeCatalogEntries.searchableDescriptionOverride })
    .from(runtimeCatalogEntries)
    .where(
      and(eq(runtimeCatalogEntries.projectId, PROJECT), eq(runtimeCatalogEntries.entryId, entryId)),
    );
  return row?.value ?? null;
}

test("applying writes the override the runtime will pull", async (t) => {
  const { client, db } = await seeded([{ entryId: "refund_payment", override: null }]);
  t.after(() => client.close());

  const [proposal] = await proposalsFor(db, [insert("refund_payment", "Refunds a payment.")]);
  const outcome = await applyProposal(PROJECT, proposal.id, "user_1", deps(db));
  assert.deepEqual(outcome, { ok: true, status: "applied" });
  assert.equal(await overrideOf(db, "refund_payment"), "Refunds a payment.");

  // And the corpus now resolves to the new text, which is what retrieval matches.
  const corpus = await loadToolCorpus(PROJECT, db);
  const entry = corpus.find((row) => row.entryId === "refund_payment");
  assert.equal(entry?.searchable, "Refunds a payment.");
  assert.equal(entry?.source, "override");
});

test("reverting restores an operator's own text exactly", async (t) => {
  const { client, db } = await seeded([
    { entryId: "refund_payment", override: "hand written by an operator" },
  ]);
  t.after(() => client.close());

  const [proposal] = await proposalsFor(db, [insert("refund_payment", "Model text.")]);
  await applyProposal(PROJECT, proposal.id, "user_1", deps(db));
  assert.equal(await overrideOf(db, "refund_payment"), "Model text.");

  await revertProposal(PROJECT, proposal.id, deps(db));
  assert.equal(await overrideOf(db, "refund_payment"), "hand written by an operator");
});

test("reverting an entry with no prior override clears it rather than blanking it", async (t) => {
  const { client, db } = await seeded([{ entryId: "t", override: null }]);
  t.after(() => client.close());

  const [proposal] = await proposalsFor(db, [insert("t", "Model text.")]);
  await applyProposal(PROJECT, proposal.id, "user_1", deps(db));
  await revertProposal(PROJECT, proposal.id, deps(db));

  assert.equal(await overrideOf(db, "t"), null);
  // Back to the runtime's own text, not an empty string.
  const corpus = await loadToolCorpus(PROJECT, db);
  assert.equal(corpus[0].searchable, "Runtime searchable text for t.");
  assert.equal(corpus[0].source, "runtime");
});

test("a proposal for an entry that has since been removed fails without touching anything", async (t) => {
  const { client, db } = await seeded([{ entryId: "stays", override: null }]);
  t.after(() => client.close());

  const proposals = await proposalsFor(db, [insert("stays", "A"), insert("gone", "B")]);
  const gone = proposals.find((row) => row.entryId === "gone");
  assert.ok(gone);

  const outcome = await applyProposal(PROJECT, gone.id, "user_1", deps(db));
  assert.deepEqual(outcome, { ok: false, reason: "entry_gone" });
  const still = await getProposal(PROJECT, gone.id, db);
  assert.equal(still?.status, "pending", "it stays actionable rather than reading as applied");
});

test("apply-all keeps every good edit and reports only the ones that could not land", async (t) => {
  const { client, db } = await seeded([
    { entryId: "a", override: null },
    { entryId: "b", override: "existing b" },
  ]);
  t.after(() => client.close());

  const proposals = await proposalsFor(db, [
    insert("a", "New a."),
    insert("gone", "New gone."),
    insert("b", "New b."),
  ]);
  const outcome = await applyProposals(
    PROJECT,
    proposals.map((row) => row.id),
    "user_1",
    deps(db),
  );

  assert.equal(outcome.applied.length, 2);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].reason, "entry_gone");
  assert.equal(await overrideOf(db, "a"), "New a.");
  assert.equal(await overrideOf(db, "b"), "New b.");

  // Every applied row remembers what it displaced, so reverting the batch is exact.
  const applied = await listProposals(PROJECT, { statuses: ["applied"] }, db);
  const bRow = applied.find((row) => row.entryId === "b");
  assert.equal(bRow?.previousOverride, "existing b");
  const aRow = applied.find((row) => row.entryId === "a");
  assert.equal(aRow?.previousOverride, null);
});

test("the corpus reports whether searchable text differs from the agent description", async (t) => {
  const { client, db } = await seeded([{ entryId: "t", override: null }]);
  t.after(() => client.close());

  const before = await loadToolCorpus(PROJECT, db);
  assert.equal(before[0].matchesAgentDescription, false);

  await setRuntimeCatalogOverride(PROJECT, "tool", "t", "Agent-facing text for t.", db);
  const after = await loadToolCorpus(PROJECT, db);
  assert.equal(after[0].matchesAgentDescription, true);
});

test("the swap returns the value it displaced, not the one it just wrote", async (t) => {
  // The obvious implementation (a scalar subquery over the same table inside
  // RETURNING) reads the NEW row and answers null: a silent wrong answer that
  // would make every Revert a no-op. Pinned because it is not visible in review.
  const { client, db } = await seeded([
    { entryId: "had_one", override: "displaced text" },
    { entryId: "had_none", override: null },
  ]);
  t.after(() => client.close());

  const first = await swapRuntimeOverride(PROJECT, "had_one", "new text", db);
  assert.deepEqual(first, { previous: "displaced text" });
  assert.equal(await overrideOf(db, "had_one"), "new text");

  // An entry that exists with no override answers null, which is different from
  // an entry that does not exist at all.
  assert.deepEqual(await swapRuntimeOverride(PROJECT, "had_none", "x", db), { previous: null });
  assert.equal(await swapRuntimeOverride(PROJECT, "not_here", "x", db), undefined);

  // Swapping twice returns each prior value in turn, so a revert chain is exact.
  assert.deepEqual(await swapRuntimeOverride(PROJECT, "had_one", "third text", db), {
    previous: "new text",
  });
  assert.deepEqual(await swapRuntimeOverride(PROJECT, "had_one", null, db), {
    previous: "third text",
  });
  assert.equal(await overrideOf(db, "had_one"), null);
});

test("only tool entries are in the corpus", async (t) => {
  const { client, db } = await seeded([{ entryId: "a-tool", override: null }]);
  t.after(() => client.close());
  await db.insert(runtimeCatalogEntries).values({
    projectId: PROJECT,
    kind: "skill",
    entryId: "a-skill",
    name: "a-skill",
    description: "d",
    tags: [],
    searchableDescription: "s",
    searchableDescriptionOverridden: false,
    useCloudDefinitions: false,
    searchableDescriptionOverride: null,
    contentHash: "h",
  });

  const corpus = await loadToolCorpus(PROJECT, db);
  assert.deepEqual(
    corpus.map((row) => row.entryId),
    ["a-tool"],
  );
});
