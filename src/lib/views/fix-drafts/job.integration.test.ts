import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { matchQualityRuns } from "@/lib/synthesis/match-quality/schema";
import { changeOf } from "@/lib/views/eval-gate/change";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { runSimulation } from "@/lib/views/eval-gate/service";
import { draftFixJob, enqueueProjectFixDrafts } from "@/lib/views/fix-drafts/job";
import { STAND_IN_SUFFIX } from "@/lib/views/fix-drafts/model";
import { computeSeamFills, fixDraftsRegistration } from "@/lib/views/fix-drafts/register";
import { NO_DRAFT_MODEL_MESSAGE, resolveFixChange } from "@/lib/views/fix-drafts/resolve";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";
import { fixDraftSpendSince, latestFixDraft } from "@/lib/views/fix-drafts/store";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-01T12:00:00Z");
// Owned (ADR-0030): the gate is FF_EVAL_GATE, read from env, where upstream stubs flag deps. The
// stand-in model stands for a key; the simulations read process.env through the seam.
const ON = { FF_EVAL_GATE: "1", EVAL_GATE_MOCK_MODEL: "1" };
const OFF = { FF_EVAL_GATE: "0" };
const NO_KEY = { FF_EVAL_GATE: "1" };
process.env.FF_EVAL_GATE = "1";
process.env.EVAL_GATE_MOCK_MODEL = "1";

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Test', 'test');
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await upsertRuntimeCatalogEntries(
    [
      {
        projectId: PROJECT,
        kind: "tool",
        entryId: "lookup_order",
        name: "lookup_order",
        description: "Fetch a purchase record.",
        searchableDescription: "Fetch a purchase record.",
        searchableDescriptionOverridden: false,
        tags: [],
        inputSchema: null,
        outputSchema: null,
        contentHash: "test",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ],
    "events",
    db,
  );
  for (let n = 1; n <= 2; n++) {
    const turnId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
    const searchId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
    const invokeId = `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, search_count, invoke_count)
      values ($1, $2, $3, $3, 'declared', 'runtime', 'closed', $4, $4, $4, 1, 1)`,
      [turnId, PROJECT, `test-${n}`, NOW],
    );
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, query, payload)
      values ($1, $2, 'search', $3, $4, $4, $6, $3, 'where is my order', '{}'), ($5, $2, 'invoke_end', $3, $4, $4, $7, $3, null, '{}')`,
      [searchId, PROJECT, `test-${n}`, NOW, invokeId, `draft-search-${n}`, `draft-invoke-${n}`],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_ordinal, search_type, hit_ids, hit_count)
      values ($1, $2, 1, 'search', 'search', $3, $4, $4, 1, 'search', '{}', 0)`,
      [turnId, PROJECT, searchId, NOW],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
      values ($1, $2, 2, 'invoke', 'invoke_end', $3, $4, $4, 'tool', 'lookup_order', 'ok')`,
      [turnId, PROJECT, invokeId, NOW],
    );
  }
  await client.query(
    `insert into trace_signals (id, project_id, kind, subject_kind, subject_key, subject, status, severity, impact, n, metrics, evidence, first_seen_at, last_seen_at)
    values ($1, $2, 'first_try_miss', 'tool', 'lookup_order', '{"ids":["lookup_order"]}', 'open', 0.4, 10, 2, '{}', '{"turnIds":["aaaaaaaa-aaaa-4aaa-8aaa-000000000001"]}', $3, $3)`,
    [ISSUE, PROJECT, NOW],
  );
  const base = buildFixes(fixesInput()).open.find((fix) => fix.source === "rewrite")!;
  const fix: Fix = {
    ...base,
    id: `issue:${ISSUE}`,
    sourceId: ISSUE,
    source: "issue",
    aliases: [],
    issues: [
      {
        id: ISSUE,
        kind: "first_try_miss",
        title: "Orders are missed",
        claim: "",
        cost: "",
        figure: null,
        href: "",
      },
    ],
    detail: { source: "issue", changes: ["Name the order lookup use case."], caveat: null },
  };
  return { client, db, fix };
}

test("draft_fix writes a usable rewrite without a Quality run", async () => {
  const { client, db, fix } = await setup();
  try {
    let calls = 0;
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async ({ user, maxTokens }) => {
            calls++;
            assert.match(user, /lookup_order/);
            assert.match(user, /where is my order/);
            assert.ok(maxTokens <= 1024);
            return {
              text: JSON.stringify({
                diagnosis: "Order searches miss this tool.",
                proposals: [
                  {
                    entryId: "lookup_order",
                    searchableDescription:
                      "Fetch a purchase record. Find order status by order reference.",
                  },
                ],
              }),
              usage: { inputTokens: 300, outputTokens: 80 },
            };
          },
        },
      },
    );
    assert.equal(result.status, "ready");
    assert.equal(calls, 1);
    const draft = await latestFixDraft(PROJECT, fix.id, db);
    assert.ok(draft);
    assert.equal(draft.origin, "drafted");
    assert.equal(draft.model, "claude-sonnet-5-5");
    assert.equal(
      changeOf(fix, draft.change).patches.lookup_order,
      "Fetch a purchase record. Find order status by order reference.",
    );
    assert.ok(Number((draft.spend as { usd: number }).usd) <= 0.05);
    assert.equal(
      (await resolveFixChange(PROJECT, fix, { db, env: ON, environment: "test" })).status,
      "ready",
    );
    const simulated = await runSimulation(fix.id, {
      projectId: PROJECT,
      deps: {
        db,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        models: { agent: null, tool: null, judge: null, standIn: false },
      },
    });
    assert.equal(simulated.status, "completed");
    assert.equal(simulated.nSimulated, 1);
    assert.equal((await db.select().from(matchQualityRuns)).length, 0);
  } finally {
    await client.close();
  }
});

test("draft_fix refuses the daily organization budget before calling the model", async () => {
  const { client, db, fix } = await setup();
  try {
    let calls = 0;
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        dailyBudgetUsd: 0,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async () => {
            calls++;
            throw new Error("The budget must prevent this call.");
          },
        },
      },
    );
    assert.equal(result.status, "budget_refused");
    assert.equal(calls, 0);
    assert.equal((await latestFixDraft(PROJECT, fix.id, db))?.status, "budget_refused");
  } finally {
    await client.close();
  }
});

test("with the gate on a missing draft queues once and never names Quality", async () => {
  const { client, db, fix } = await setup();
  try {
    const first = await resolveFixChange(PROJECT, fix, { db, env: ON, environment: "test" });
    const second = await resolveFixChange(PROJECT, fix, { db, env: ON, environment: "test" });
    assert.equal(first.status, "drafting");
    assert.match(first.change.unsupportedReason ?? "", /draft/i);
    assert.doesNotMatch(first.change.unsupportedReason ?? "", /Quality/);
    assert.equal(second.status, "drafting");
    await assert.rejects(
      runSimulation(fix.id, {
        projectId: PROJECT,
        deps: { db, loadFix: async () => ({ projectId: PROJECT, fix }) },
      }),
      (err: unknown) =>
        err instanceof Error && /draft/i.test(err.message) && !/Quality/.test(err.message),
    );
    const queued = await db.select().from(jobs);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, "draft_fix");
    const off = await resolveFixChange(PROJECT, fix, {
      db,
      env: OFF,
    });
    assert.match(off.change.unsupportedReason ?? "", /Run an analysis on Quality/);
  } finally {
    await client.close();
  }
});

test("the draft analyst reads the tool's evidence ask without a later unrelated search", async () => {
  const { client, db, fix } = await setup();
  try {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, query, payload)
      values ('dddddddd-dddd-4ddd-8ddd-000000000001', $1, 'search', 'test-1', $2, $2, 'unrelated', 'test-1', 'list all invoices', '{}')`,
      [PROJECT, NOW],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_ordinal, search_type, hit_ids, hit_count)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', $1, 3, 'search', 'search', 'dddddddd-dddd-4ddd-8ddd-000000000001', $2, $2, 2, 'search', '{}', 0)`,
      [PROJECT, NOW],
    );
    await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async ({ user }) => {
            assert.match(user, /where is my order/);
            assert.doesNotMatch(user, /list all invoices/);
            return {
              text: JSON.stringify({
                diagnosis: "Order searches miss this tool.",
                proposals: [
                  {
                    entryId: "lookup_order",
                    searchableDescription: "Fetch orders by their reference.",
                  },
                ],
              }),
              usage: { inputTokens: 300, outputTokens: 40 },
            };
          },
        },
      },
    );
  } finally {
    await client.close();
  }
});

test("the draft budget includes spend from another project in the same organization", async () => {
  const { client, db, fix } = await setup();
  try {
    const otherProject = "33333333-3333-4333-8333-333333333333";
    await client.query(
      `insert into projects (id, organization_id, name, slug) values ($1, $2, 'Other', 'other')`,
      [otherProject, ORG],
    );
    await db.insert(fixDrafts).values({
      projectId: otherProject,
      fixId: "issue:other",
      status: "ready",
      createdBy: "user_test",
      spend: { usd: 9.98 },
      createdAt: NOW,
    });
    const { organizationModelSpendSince } = await import("@/lib/views/eval-gate/store");
    assert.equal(
      await organizationModelSpendSince(PROJECT, new Date(NOW.getTime() - 86_400_000), db),
      9.98,
    );
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async () => {
            throw new Error("The shared budget must prevent this call.");
          },
        },
      },
    );
    assert.equal(result.status, "budget_refused");
  } finally {
    await client.close();
  }
});

test("the draft cap refuses oversized prompts before the model call", async () => {
  const { client, db, fix } = await setup();
  try {
    const { eq } = await import("drizzle-orm");
    await db
      .update(runtimeCatalogEntries)
      .set({ searchableDescription: "large description ".repeat(2500) })
      .where(eq(runtimeCatalogEntries.projectId, PROJECT));
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async () => {
            throw new Error("The draft cap must prevent this call.");
          },
        },
      },
    );
    assert.equal(result.status, "budget_refused");
  } finally {
    await client.close();
  }
});

test("a disabled draft job makes no model call or draft row", async () => {
  const { client, db, fix } = await setup();
  try {
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: OFF,
        loadFix: async () => {
          throw new Error("A disabled job must not load the fix.");
        },
        model: {
          model: "claude-sonnet-5-5",
          complete: async () => {
            throw new Error("A disabled job must not call the model.");
          },
        },
      },
    );
    assert.equal(result.status, "gate_off");
    assert.equal(await latestFixDraft(PROJECT, fix.id, db), null);
  } finally {
    await client.close();
  }
});

test("a tell-apart draft writes replacements for both tools in one model call", async () => {
  const { client, db, fix } = await setup();
  try {
    await upsertRuntimeCatalogEntries(
      [
        {
          projectId: PROJECT,
          kind: "tool",
          entryId: "track_parcel",
          name: "track_parcel",
          description: "Track a parcel in transit.",
          searchableDescription: "Track a parcel in transit.",
          searchableDescriptionOverridden: false,
          tags: [],
          inputSchema: null,
          outputSchema: null,
          contentHash: "parcel",
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
      "events",
      db,
    );
    const pair: Fix = {
      ...fix,
      kind: "tell-apart",
      subject: {
        ...fix.subject,
        tools: [...fix.subject.tools, { id: "track_parcel", label: "track_parcel", href: "" }],
      },
    };
    let calls = 0;
    const result = await draftFixJob(
      PROJECT,
      { fixId: pair.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix: pair }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async ({ user }) => {
            calls++;
            assert.match(user, /lookup_order/);
            assert.match(user, /track_parcel/);
            return {
              text: JSON.stringify({
                diagnosis: "The tools need distinct use cases.",
                proposals: [
                  {
                    entryId: "lookup_order",
                    searchableDescription:
                      "Find purchase details by order reference. Excludes parcel location.",
                  },
                  {
                    entryId: "track_parcel",
                    searchableDescription:
                      "Find the current location of a parcel in transit. Excludes purchase details.",
                  },
                ],
              }),
              usage: { inputTokens: 400, outputTokens: 100 },
            };
          },
        },
      },
    );
    assert.equal(result.status, "ready");
    assert.equal(calls, 1);
    const draft = await latestFixDraft(PROJECT, pair.id, db);
    assert.deepEqual(Object.keys(draft!.change.patches).sort(), ["lookup_order", "track_parcel"]);
  } finally {
    await client.close();
  }
});

test("a reply without a usable proposal fails the draft and says why, without a throw", async () => {
  const { client, db, fix } = await setup();
  try {
    const result = await draftFixJob(
      PROJECT,
      { fixId: fix.id },
      {
        db,
        env: ON,
        now: () => NOW,
        loadFix: async () => ({ projectId: PROJECT, fix }),
        model: {
          model: "claude-sonnet-5-5",
          complete: async () => ({
            text: JSON.stringify({
              diagnosis: "The description already names order lookups.",
              proposals: [
                { entryId: "lookup_order", searchableDescription: "Fetch a purchase record." },
                { entryId: "unknown_tool", searchableDescription: "Something else." },
              ],
            }),
            usage: { inputTokens: 300, outputTokens: 40 },
          }),
        },
      },
    );
    assert.deepEqual(result, {
      status: "failed",
      id: result.id,
      reason: "no_usable_draft",
      rejected: ["unknown_tool"],
    });
    const draft = await latestFixDraft(PROJECT, fix.id, db);
    assert.equal(draft?.status, "failed");
    assert.equal((draft?.spend as { calls: number }).calls, 1);
  } finally {
    await client.close();
  }
});

// Owned (ADR-0030): the cases this edition adds.

test("with the gate on and no model key nothing is queued, reserved, written or sent", async () => {
  const { client, db, fix } = await setup();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    for (const env of [NO_KEY, { ...NO_KEY, ANTHROPIC_API_KEY: "REPLACE_ME" }]) {
      const resolved = await resolveFixChange(PROJECT, fix, { db, env, environment: "test" });
      assert.equal(resolved.status, "unsupported");
      assert.equal(resolved.change.unsupportedReason, NO_DRAFT_MODEL_MESSAGE);
      const result = await draftFixJob(
        PROJECT,
        { fixId: fix.id },
        {
          db,
          env,
          environment: "test",
          now: () => NOW,
          loadFix: async () => ({ projectId: PROJECT, fix }),
        },
      );
      assert.equal(result.status, "no_model");
    }
    assert.equal((await db.select().from(jobs)).length, 0);
    assert.equal(await latestFixDraft(PROJECT, fix.id, db), null);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
  }
});

test("EVAL_GATE_MOCK_MODEL=1 drafts with the local stand-in, outside production only", async () => {
  const { client, db, fix } = await setup();
  try {
    const deps = {
      db,
      env: ON,
      now: () => NOW,
      loadFix: async () => ({ projectId: PROJECT, fix }),
    };
    const result = await draftFixJob(PROJECT, { fixId: fix.id }, { ...deps, environment: "test" });
    assert.equal(result.status, "ready");
    const draft = await latestFixDraft(PROJECT, fix.id, db);
    assert.equal(draft?.change.patches.lookup_order, `Fetch a purchase record. ${STAND_IN_SUFFIX}`);
    const { client: other, db: prodDb, fix: prodFix } = await setup();
    try {
      const prod = await draftFixJob(
        PROJECT,
        { fixId: prodFix.id },
        {
          ...deps,
          db: prodDb,
          environment: "production",
          loadFix: async () => ({ projectId: PROJECT, fix: prodFix }),
        },
      );
      assert.equal(prod.status, "no_model");
    } finally {
      await other.close();
    }
  } finally {
    await client.close();
  }
});

test("loading the module fills the eval gate seams and registers draft_fix", () => {
  assert.equal(evalGateSeams.resolveChange, resolveFixChange);
  assert.equal(
    evalGateSeams.spendSince.filter((read) => read === fixDraftSpendSince).length,
    1,
    "the drafts' spend reader is added once",
  );
  assert.deepEqual(Object.keys(fixDraftsRegistration.jobs ?? {}), ["draft_fix"]);
  assert.equal(computeSeams.enqueueFixDrafts, computeSeamFills.enqueueFixDrafts);
});

test("the pending index allows one queued or running draft_fix job per fix", async () => {
  const { client, db } = await setup();
  try {
    const row = { projectId: PROJECT, kind: "draft_fix", payload: { fixId: "issue:x" } };
    await db.insert(jobs).values(row);
    const again = await db.insert(jobs).values(row).onConflictDoNothing().returning();
    assert.equal(again.length, 0);
    await db.insert(jobs).values({ ...row, payload: { fixId: "issue:y" } });
    assert.equal((await db.select().from(jobs)).length, 2);
  } finally {
    await client.close();
  }
});

test("after a signal run, drafts are queued only for open rewrites with no draft, and only with a model", async () => {
  const { client, db, fix } = await setup();
  try {
    const other: Fix = { ...fix, id: "issue:drafted" };
    const notRewrite: Fix = { ...fix, id: "issue:retry", kind: "retry" as Fix["kind"] };
    await db.insert(fixDrafts).values({
      projectId: PROJECT,
      fixId: other.id,
      status: "ready",
      createdBy: "system:fix-drafts",
      change: { patches: { lookup_order: "Already drafted." } },
      createdAt: NOW,
    });
    const loadOpenFixes = async () => [fix, other, notRewrite];
    for (const env of [OFF, NO_KEY]) {
      await enqueueProjectFixDrafts(PROJECT, { db, env, environment: "test", loadOpenFixes });
    }
    assert.equal((await db.select().from(jobs)).length, 0, "gate off or no key queues nothing");
    await enqueueProjectFixDrafts(PROJECT, { db, env: ON, environment: "test", loadOpenFixes });
    await enqueueProjectFixDrafts(PROJECT, { db, env: ON, environment: "test", loadOpenFixes });
    const queued = await db.select().from(jobs);
    assert.deepEqual(
      queued.map((job) => [job.kind, (job.payload as { fixId: string }).fixId]),
      [["draft_fix", fix.id]],
    );
  } finally {
    await client.close();
  }
});
