import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations, users } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import {
  matchQualityEvalItems,
  matchQualityProposals,
  matchQualityRuns,
} from "@/lib/synthesis/match-quality/schema";
import { catalogFingerprints } from "@/lib/synthesis/quality/schema";
import type { ProposalInsert } from "./queries";
import {
  countRunsSince,
  finishRun,
  getLatestRun,
  insertEvalItems,
  lastCorpusChangeAt,
  lastRunByProject,
  listProposals,
  persistFinishedRun,
  replacePendingProposals,
  startRun,
  transitionProposal,
} from "./queries";
import type { EvalItem, ProposalPreview, RunCensus } from "./types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-14T12:00:00Z");

async function seeded() {
  const client = await createMigratedPGlite();
  // Cast once, here. PGlite and node-postgres expose an identical query surface
  // and differ only in the driver metadata on a result, so every `lib/` helper
  // works against this handle; casting at each of the forty call sites instead
  // would bury that fact in noise.
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await db.insert(users).values({ id: USER, externalId: "user_1", email: "a@b.c" });
  await db.insert(projects).values({ id: PROJECT, organizationId: ORG, name: "P", slug: "p" });
  return { client, db };
}

function census(): RunCensus {
  return {
    selectionsEvaluated: 40,
    revealedN: 30,
    referenceN: 10,
    judgedN: 0,
    queriesCaptured: 40,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: "ratel.experiment.invocation.tool_id",
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
  };
}

function preview(): ProposalPreview {
  return {
    scorer: "bm25-spotcheck",
    hits: [{ query: "q", targetEntryId: "t", before: null, after: 1 }],
    improved: 1,
    worsened: 0,
    unchanged: 0,
    reproductionRate: 0.7,
    reproductionSample: 20,
    inconclusive: false,
  };
}

function proposalInsert(entryId: string, text: string): ProposalInsert {
  return {
    proposal: {
      entryId,
      searchableDescription: text,
      rationale: "because",
      details: "the full audit",
      expectedEffect: "better",
    },
    entry: {
      entryId,
      name: entryId,
      searchable: "old text",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
    preview: preview(),
    evidence: { misses: 3 },
  };
}

function runInput(trigger: "scheduled" | "manual" = "scheduled") {
  return {
    projectId: PROJECT,
    experimentName: "exp",
    trigger,
    windowDays: 7,
    windowStart: new Date(NOW.getTime() - 7 * 86_400_000),
    windowEnd: NOW,
  };
}

test("a project may only have one live run at a time", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const first = await startRun(runInput(), db, NOW);
  assert.ok(first);
  // The partial unique index refuses the second, so a weekly sweep racing a
  // manual click cannot spend two model calls on one window.
  const second = await startRun(runInput("manual"), db, NOW);
  assert.equal(second, null);

  await finishRun(
    first.id,
    {
      census: census(),
      scores: {},
      observedStages: {},
      followThrough: {},
      corpusFingerprint: "fp",
      model: "m",
      mocked: false,
      diagnosis: "d",
      diagnosisPoints: [],
      declinedReason: null,
      scorer: "bm25-spotcheck",
      judge: {},
    },
    db,
    NOW,
  );
  // Once it finishes, the slot is free again.
  const third = await startRun(runInput("manual"), db, NOW);
  assert.ok(third);
});

test("finishing a run stores the census the surface reads back", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  await finishRun(
    run.id,
    {
      census: census(),
      scores: { arms: [] },
      observedStages: { stages: ["bm25"] },
      followThrough: { arms: [] },
      corpusFingerprint: "fp-1",
      model: "claude-sonnet-5",
      mocked: false,
      diagnosis: "near-synonyms",
      diagnosisPoints: [],
      declinedReason: null,
      scorer: "bm25-spotcheck",
      judge: {},
    },
    db,
    NOW,
  );

  const latest = await getLatestRun(PROJECT, db);
  assert.equal(latest?.status, "analyzed");
  assert.equal(latest?.revealedN, 30);
  assert.equal(latest?.attributionMode, "tool-id");
  assert.equal(latest?.invokedToolKey, "ratel.experiment.invocation.tool_id");
  assert.equal(latest?.corpusFingerprint, "fp-1");
  assert.equal(latest?.diagnosis, "near-synonyms");
});

test("a second run supersedes the first run's pending proposals", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const first = await startRun(runInput(), db, NOW);
  assert.ok(first);
  await replacePendingProposals(
    first.id,
    PROJECT,
    [proposalInsert("refund_payment", "v1"), proposalInsert("list_invoices", "v1")],
    db,
    NOW,
  );
  assert.equal((await listProposals(PROJECT, { statuses: ["pending"] }, db)).length, 2);

  await finishRun(
    first.id,
    {
      census: census(),
      scores: {},
      observedStages: {},
      followThrough: {},
      corpusFingerprint: null,
      model: null,
      mocked: false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: null,
      scorer: "none",
      judge: {},
    },
    db,
    NOW,
  );

  const second = await startRun(runInput("manual"), db, NOW);
  assert.ok(second);
  const created = await replacePendingProposals(
    second.id,
    PROJECT,
    [proposalInsert("refund_payment", "v2")],
    db,
    NOW,
  );
  assert.equal(created, 1);

  const pending = await listProposals(PROJECT, { statuses: ["pending"] }, db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposedSearchable, "v2");
  const superseded = await listProposals(PROJECT, { statuses: ["superseded"] }, db);
  assert.equal(superseded.length, 2);
});

test("an applied proposal is not superseded by the next run", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const first = await startRun(runInput(), db, NOW);
  assert.ok(first);
  await replacePendingProposals(first.id, PROJECT, [proposalInsert("t", "v1")], db, NOW);
  const [pending] = await listProposals(PROJECT, { statuses: ["pending"] }, db);
  await transitionProposal(
    pending.id,
    "pending",
    "applied",
    { appliedAt: NOW, appliedBy: "user_1", previousOverride: null },
    db,
    NOW,
  );

  await finishRun(
    first.id,
    {
      census: census(),
      scores: {},
      observedStages: {},
      followThrough: {},
      corpusFingerprint: null,
      model: null,
      mocked: false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: null,
      scorer: "none",
      judge: {},
    },
    db,
    NOW,
  );
  const second = await startRun(runInput("manual"), db, NOW);
  assert.ok(second);
  await replacePendingProposals(second.id, PROJECT, [], db, NOW);

  const applied = await listProposals(PROJECT, { statuses: ["applied"] }, db);
  assert.equal(applied.length, 1, "an applied edit is history, not a stale suggestion");
});

test("a transition only fires from the state it is allowed to leave", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  await replacePendingProposals(run.id, PROJECT, [proposalInsert("t", "v1")], db, NOW);
  const [row] = await listProposals(PROJECT, { statuses: ["pending"] }, db);

  assert.equal(await transitionProposal(row.id, "pending", "applied", {}, db, NOW), true);
  // A second operator's claim finds it gone and changes nothing.
  assert.equal(await transitionProposal(row.id, "pending", "applied", {}, db, NOW), false);
});

test("the pending-per-entry index stops one run stacking duplicates", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  await assert.rejects(
    replacePendingProposals(
      run.id,
      PROJECT,
      [proposalInsert("same", "a"), proposalInsert("same", "b")],
      db,
      NOW,
    ),
  );
  assert.equal((await listProposals(PROJECT, {}, db)).length, 0, "the batch rolled back");
});

test("eval items are frozen against the run and survive as a value", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  const items: EvalItem[] = [
    {
      selectionId: "s1",
      occurredAt: NOW,
      query: "give the money back",
      targetEntryId: "refund_payment",
      targetKind: "tool",
      targetSource: "invoked",
      arms: [
        { arm: "ratel", role: "serving", resultIds: ["list_invoices"], resultScores: [0.4] },
        { arm: "legacy", role: "shadow", resultIds: ["refund_payment"], resultScores: null },
      ],
    },
  ];
  await insertEvalItems(run.id, PROJECT, items, db);

  const stored = await db
    .select()
    .from(matchQualityEvalItems)
    .where(eq(matchQualityEvalItems.runId, run.id));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].targetSource, "invoked");
  assert.deepEqual(stored[0].arms[0].resultIds, ["list_invoices"]);
  assert.deepEqual(stored[0].arms[0].resultScores, [0.4]);
});

test("deleting a run cascades its frozen evidence and proposals away", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  await insertEvalItems(
    run.id,
    PROJECT,
    [
      {
        selectionId: "s1",
        occurredAt: NOW,
        query: "q",
        targetEntryId: "t",
        targetKind: "tool",
        targetSource: "reference",
        arms: [],
      },
    ],
    db,
  );
  await replacePendingProposals(run.id, PROJECT, [proposalInsert("t", "v")], db, NOW);

  await db.delete(matchQualityRuns).where(eq(matchQualityRuns.id, run.id));
  assert.equal((await db.select().from(matchQualityEvalItems)).length, 0);
  assert.equal((await db.select().from(matchQualityProposals)).length, 0);
});

test("the run budget counts runs created in the period", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const periodStart = new Date("2026-09-01T00:00:00Z");
  assert.equal(await countRunsSince(PROJECT, periodStart, db), 0);

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  assert.equal(await countRunsSince(PROJECT, periodStart, db), 1);
  // A run from last month does not spend this month's budget.
  assert.equal(await countRunsSince(PROJECT, new Date("2026-10-01T00:00:00Z"), db), 0);
});

test("the sweep's rotation order comes from the newest run per project", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const older = new Date("2026-09-01T00:00:00Z");
  const run = await startRun(runInput(), db, older);
  assert.ok(run);
  await finishRun(
    run.id,
    {
      census: census(),
      scores: {},
      observedStages: {},
      followThrough: {},
      corpusFingerprint: null,
      model: null,
      mocked: false,
      diagnosis: null,
      diagnosisPoints: [],
      declinedReason: null,
      scorer: "none",
      judge: {},
    },
    db,
    older,
  );
  const newer = await startRun(runInput("manual"), db, NOW);
  assert.ok(newer);

  const last = await lastRunByProject(db);
  assert.equal(last.get(PROJECT)?.toISOString(), NOW.toISOString());
});

test("the last corpus change is read from the fingerprint trail, not from applies", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  assert.equal(await lastCorpusChangeAt(PROJECT, db), null);

  const older = new Date("2026-09-01T00:00:00Z");
  const newer = new Date("2026-09-10T00:00:00Z");
  await db.insert(catalogFingerprints).values([
    {
      projectId: PROJECT,
      fingerprint: "a",
      entryCount: 1,
      searchableChars: 10,
      overriddenCount: 0,
      distinctCount: 0,
      entries: [],
      firstSeenAt: older,
      lastSeenAt: older,
    },
    {
      projectId: PROJECT,
      fingerprint: "b",
      entryCount: 1,
      searchableChars: 12,
      overriddenCount: 1,
      distinctCount: 1,
      entries: [],
      firstSeenAt: newer,
      lastSeenAt: newer,
    },
  ]);
  const changed = await lastCorpusChangeAt(PROJECT, db);
  assert.equal(changed?.toISOString(), newer.toISOString());
});

test("a run's evidence, proposals and closing row land together or not at all", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);

  const items: EvalItem[] = [
    {
      selectionId: "s1",
      occurredAt: NOW,
      query: "q",
      targetEntryId: "t",
      targetKind: "tool",
      targetSource: "invoked",
      arms: [],
    },
  ];
  const finish = {
    census: census(),
    scores: {},
    observedStages: {},
    followThrough: {},
    corpusFingerprint: "fp",
    model: "m",
    mocked: false,
    diagnosis: "d",
    diagnosisPoints: [],
    declinedReason: null,
    scorer: "bm25-spotcheck",
    judge: {},
  };

  // Two proposals for one entry violate the pending-per-entry index, so the
  // insert fails partway. Without one transaction the eval items would already
  // be committed and the run would still be closed as analyzed, leaving a run
  // that claims to have read a window it has no record of.
  await assert.rejects(
    persistFinishedRun(
      run.id,
      PROJECT,
      items,
      [proposalInsert("same", "a"), proposalInsert("same", "b")],
      finish,
      db,
      NOW,
    ),
  );
  assert.equal((await db.select().from(matchQualityEvalItems)).length, 0);
  assert.equal((await db.select().from(matchQualityProposals)).length, 0);
  const stillOpen = await getLatestRun(PROJECT, db);
  assert.equal(stillOpen?.status, "queued", "the run was not closed by a failed persist");

  // The same call with a valid batch commits all three.
  await persistFinishedRun(run.id, PROJECT, items, [proposalInsert("t", "v")], finish, db, NOW);
  assert.equal((await db.select().from(matchQualityEvalItems)).length, 1);
  assert.equal((await db.select().from(matchQualityProposals)).length, 1);
  assert.equal((await getLatestRun(PROJECT, db))?.status, "analyzed");
});

test("proposals are scoped to their project", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());
  const other = "44444444-4444-4444-8444-444444444444";
  await db.insert(projects).values({ id: other, organizationId: ORG, name: "Q", slug: "q" });

  const run = await startRun(runInput(), db, NOW);
  assert.ok(run);
  await replacePendingProposals(run.id, PROJECT, [proposalInsert("t", "v")], db, NOW);

  assert.equal((await listProposals(other, {}, db)).length, 0);
  assert.equal(
    (
      await db
        .select()
        .from(matchQualityProposals)
        .where(
          and(
            eq(matchQualityProposals.projectId, PROJECT),
            eq(matchQualityProposals.status, "pending"),
          ),
        )
    ).length,
    1,
  );
});

/* — the answer key ----------------------------------------------------------- */

import type { GroundTruthLabel } from "./labels";
import { countLabels, loadLabels, loadReplayHistory, upsertLabels } from "./queries";

const KEY_EARLY = new Date("2026-08-01T09:00:00Z");
const KEY_LATE = new Date("2026-09-12T09:00:00Z");

function keyRow(overrides: Partial<GroundTruthLabel> = {}): GroundTruthLabel {
  return {
    queryKey: "refund the customer",
    query: "refund the customer",
    entryId: "refund_payment",
    source: "judge",
    confident: true,
    model: "claude-sonnet-5",
    selectionId: "sel-1",
    occurrences: 1,
    observedAt: KEY_EARLY,
    ...overrides,
  };
}

test("a label is written once and read back keyed by its query", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(PROJECT, [keyRow()], db, NOW);
    const loaded = await loadLabels(PROJECT, db);

    assert.equal(loaded.size, 1);
    assert.equal(loaded.get("refund the customer")?.entryId, "refund_payment");
    assert.equal(loaded.get("refund the customer")?.source, "judge");
  } finally {
    await client.close();
  }
});

test("an observed invocation overwrites a judged verdict, in SQL", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(PROJECT, [keyRow({ source: "judge", entryId: "list_invoices" })], db, NOW);
    await upsertLabels(
      PROJECT,
      // Deliberately OLDER, to prove strength beats recency rather than the two
      // happening to agree.
      [
        keyRow({
          source: "invoked",
          entryId: "refund_payment",
          observedAt: KEY_EARLY,
          model: null,
        }),
      ],
      db,
      NOW,
    );

    const loaded = await loadLabels(PROJECT, db);
    assert.equal(loaded.get("refund the customer")?.entryId, "refund_payment");
    assert.equal(loaded.get("refund the customer")?.source, "invoked");
  } finally {
    await client.close();
  }
});

test("a judged verdict never displaces an observed invocation, in SQL", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(
      PROJECT,
      [keyRow({ source: "invoked", entryId: "refund_payment" })],
      db,
      NOW,
    );
    await upsertLabels(
      PROJECT,
      [keyRow({ source: "judge", entryId: "list_invoices", observedAt: KEY_LATE })],
      db,
      NOW,
    );

    const loaded = await loadLabels(PROJECT, db);
    assert.equal(loaded.get("refund the customer")?.entryId, "refund_payment");
    assert.equal(loaded.get("refund the customer")?.source, "invoked");
  } finally {
    await client.close();
  }
});

test("between two verdicts of equal strength the newer one wins", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(
      PROJECT,
      [keyRow({ entryId: "list_invoices", observedAt: KEY_EARLY })],
      db,
      NOW,
    );
    await upsertLabels(
      PROJECT,
      [keyRow({ entryId: "refund_payment", observedAt: KEY_LATE })],
      db,
      NOW,
    );

    assert.equal(
      (await loadLabels(PROJECT, db)).get("refund the customer")?.entryId,
      "refund_payment",
    );
  } finally {
    await client.close();
  }
});

test("occurrences accumulate across runs even when the answer does not change", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(PROJECT, [keyRow({ occurrences: 3 })], db, NOW);
    await upsertLabels(PROJECT, [keyRow({ occurrences: 4, observedAt: KEY_LATE })], db, NOW);

    assert.equal((await loadLabels(PROJECT, db)).get("refund the customer")?.occurrences, 7);
  } finally {
    await client.close();
  }
});

test("the key is counted by source, so the surface can say what it stands on", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(
      PROJECT,
      [
        keyRow({ queryKey: "a", query: "a", source: "invoked" }),
        keyRow({ queryKey: "b", query: "b", source: "invoked" }),
        keyRow({ queryKey: "c", query: "c", source: "judge" }),
      ],
      db,
      NOW,
    );

    assert.deepEqual(await countLabels(PROJECT, db), { invoked: 2, judged: 1, unclear: 0 });
  } finally {
    await client.close();
  }
});

test("writing no labels is a no-op rather than an empty insert", async () => {
  const { client, db } = await seeded();
  try {
    assert.equal(await upsertLabels(PROJECT, [], db, NOW), 0);
    assert.equal((await loadLabels(PROJECT, db)).size, 0);
  } finally {
    await client.close();
  }
});

/* — the replayable history --------------------------------------------------- */

test("the replay history spans every run, newest first", async () => {
  const { client, db } = await seeded();
  try {
    const first = await startRun(runInput(), db, NOW);
    const second = await startRun(runInput(), db, new Date(NOW.getTime() + 60_000));
    assert.ok(first);
    // The partial unique index allows only one LIVE run, so close the first.
    assert.equal(second, null);

    await insertEvalItems(
      first.id,
      PROJECT,
      [evalItem("old", new Date("2026-08-01T00:00:00Z"))],
      db,
    );
    await insertEvalItems(
      first.id,
      PROJECT,
      [evalItem("new", new Date("2026-09-01T00:00:00Z"))],
      db,
    );

    const history = await loadReplayHistory(PROJECT, 50, db);
    assert.equal(history.length, 2);
    assert.equal(history[0].selectionId, "new");
    assert.equal(history[1].selectionId, "old");
    // The arms must survive the round trip, or the incumbent line cannot be drawn.
    assert.deepEqual(history[0].arms[0].resultIds, ["list_invoices"]);
  } finally {
    await client.close();
  }
});

test("the history read is capped, dropping the oldest evidence first", async () => {
  const { client, db } = await seeded();
  try {
    const run = await startRun(runInput(), db, NOW);
    assert.ok(run);
    await insertEvalItems(
      run.id,
      PROJECT,
      Array.from({ length: 10 }, (_unused, index) =>
        evalItem(`s${index}`, new Date(NOW.getTime() - index * 86_400_000)),
      ),
      db,
    );

    const history = await loadReplayHistory(PROJECT, 3, db);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((row) => row.selectionId),
      ["s0", "s1", "s2"],
    );
  } finally {
    await client.close();
  }
});

function evalItem(selectionId: string, at: Date): EvalItem {
  return {
    selectionId,
    occurredAt: at,
    query: `query for ${selectionId}`,
    targetEntryId: "refund_payment",
    targetKind: "tool",
    targetSource: "invoked",
    arms: [
      { arm: "ratel", role: "serving", resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "shadow", resultIds: ["refund_payment"], resultScores: null },
    ],
  };
}

test("a losing sighting still counts toward how often the request is asked", async () => {
  const { client, db } = await seeded();
  try {
    await upsertLabels(
      PROJECT,
      // `model: null` because a real invoked label has no model behind it; see
      // `harvestLabels`. Setting it here keeps the fixture honest about what the
      // assertion below is actually proving.
      [keyRow({ source: "invoked", entryId: "refund_payment", occurrences: 2, model: null })],
      db,
      NOW,
    );
    // A judged verdict that loses on strength. It must not move the answer, and
    // it must still be counted as a sighting of the request.
    await upsertLabels(
      PROJECT,
      [keyRow({ source: "judge", entryId: "list_invoices", observedAt: KEY_LATE, occurrences: 5 })],
      db,
      NOW,
    );

    const stored = (await loadLabels(PROJECT, db)).get("refund the customer");
    assert.equal(stored?.entryId, "refund_payment", "the stronger answer stands");
    assert.equal(stored?.source, "invoked");
    assert.equal(stored?.occurrences, 7, "but both sightings are counted");
    // And nothing from the losing row leaked into the surviving one.
    assert.equal(stored?.model, null);
  } finally {
    await client.close();
  }
});
