import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { repriceProjectModel, repriceStored, repriceUnpriced } from "./reprice";
import { deleteModelPrice, saveModelPrice } from "./store";

/**
 * RC-482: stored rows keep the cost they were ingested with. A price added
 * later (built-in or the project's own) reaches them only through a re-price.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
// Owned (ADR-0030): organizations are the edition's, so a change names its organization by id.
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const ELSEWHERE = "11111111-1111-4111-8111-111111111113";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org'), ('${OTHER_ORG}', 'Other', 'other');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER}', '${ORG}', 'B', 'b'), ('${ELSEWHERE}', '${OTHER_ORG}', 'C', 'c');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

let spanSeq = 0;
async function span(
  client: PGlite,
  projectId: string,
  model: string | null,
  usage: { input: number | null; output: number | null; cached?: number; written?: number },
  costUsd: string | null = null,
): Promise<string> {
  spanSeq += 1;
  const id = `b0000000-0000-4000-8000-${String(spanSeq).padStart(12, "0")}`;
  const attributes = usage.written
    ? { "gen_ai.usage.cache_creation.input_tokens": usage.written }
    : {};
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, model, input_tokens, output_tokens, cached_tokens, cost_usd, attributes)
     values ($1, $2, 'trace', $3, 'chat', 1, 'llm_call', now(), now(), 1, 0, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      projectId,
      `span${spanSeq}`,
      model,
      usage.input,
      usage.output,
      usage.cached ?? null,
      costUsd,
      JSON.stringify(attributes),
    ],
  );
  return id;
}

async function event(
  client: PGlite,
  projectId: string,
  model: string,
  input: number,
  output: number,
  spanId: string | null = null,
  costUsd: string | null = null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into events (project_id, occurred_at, model, input_tokens, output_tokens, cost_usd, trace_id, span_id)
     values ($1, now(), $2, $3, $4, $7, $5, $6) returning id`,
    [projectId, model, input, output, spanId ? "trace" : null, spanId, costUsd],
  );
  const id = rows[0]!.id;
  await client.query(
    `insert into event_metrics (event_id, project_id, event_time, tokens_by_category, splits, input_tokens, output_tokens, cost_usd, categorizer_version)
     values ($1, $2, now(), '{}', '{}', $3, $4, $5, 1)`,
    [id, projectId, input, output, costUsd],
  );
  return id;
}

async function spanCost(client: PGlite, id: string): Promise<string | null> {
  const { rows } = await client.query<{ cost: string | null }>(
    `select cost_usd::text as cost from otel_spans where id = $1`,
    [id],
  );
  return rows[0]!.cost;
}

async function eventCosts(client: PGlite, id: string): Promise<[string | null, string | null]> {
  const { rows } = await client.query<{ event: string | null; metric: string | null }>(
    `select e.cost_usd::text as event, m.cost_usd::text as metric from events e join event_metrics m on m.event_id = e.id where e.id = $1`,
    [id],
  );
  return [rows[0]!.event, rows[0]!.metric];
}

test("re-pricing unpriced rows fills the cost of every model that has a current price", async () => {
  const { client, db } = await setup();
  try {
    // claude-sonnet-5-5: $2 in, $10 out. gpt-4o: $2.50 in, $10 out.
    const sonnet = await span(client, PROJECT, "claude-sonnet-5-5", {
      input: 1_000_000,
      output: 100_000,
    });
    const gpt4o = await span(client, PROJECT, "gpt-4o-2024-08-06", { input: 1_000_000, output: 0 });
    const unknown = await span(client, PROJECT, "my-own-model", { input: 1_000, output: 1_000 });
    const noUsage = await span(client, PROJECT, "gpt-4o", { input: null, output: null });
    const priced = await span(
      client,
      PROJECT,
      "gpt-4o",
      { input: 1_000_000, output: 0 },
      "9.000000",
    );
    const otherProject = await span(client, OTHER, "gpt-4o", { input: 1_000_000, output: 0 });
    const sonnetEvent = await event(client, PROJECT, "claude-sonnet-5-5", 1_000_000, 100_000);

    const result = await repriceUnpriced(db, { projectId: PROJECT });

    assert.equal(await spanCost(client, sonnet), "3.000000");
    assert.equal(await spanCost(client, gpt4o), "2.500000");
    assert.equal(await spanCost(client, unknown), null);
    assert.equal(await spanCost(client, noUsage), null);
    assert.equal(await spanCost(client, priced), "9.000000");
    assert.equal(await spanCost(client, otherProject), null);
    assert.deepEqual(await eventCosts(client, sonnetEvent), ["3.000000", "3.000000"]);
    assert.deepEqual(result, { spans: 2, events: 1 });

    // Every project when none is named.
    await repriceUnpriced(db);
    assert.equal(await spanCost(client, otherProject), "2.500000");
  } finally {
    await client.close();
  }
});

test("re-pricing unpriced rows uses the project's own prices", async () => {
  const { client, db } = await setup();
  try {
    const own = await span(client, PROJECT, "my-own-model", {
      input: 1_000_000,
      output: 1_000_000,
    });
    await saveModelPrice(PROJECT, "my-own-model", { input: 1, output: 2 }, "user_1", db);
    await repriceUnpriced(db, { projectId: PROJECT });
    assert.equal(await spanCost(client, own), "3.000000");
  } finally {
    await client.close();
  }
});

test("re-pricing a saved model restates only the rows its key prices, dated ids and cache writes included", async () => {
  const { client, db } = await setup();
  try {
    const plain = await span(
      client,
      PROJECT,
      "gpt-4o",
      { input: 1_000_000, output: 0 },
      "2.500000",
    );
    const dated = await span(
      client,
      PROJECT,
      "gpt-4o-2024-08-06",
      { input: 2_000_000, output: 0, cached: 1_000_000, written: 500_000 },
      "5.000000",
    );
    // A wrong stored cost on a sibling model shows whether its rows were touched.
    const mini = await span(
      client,
      PROJECT,
      "gpt-4o-mini",
      { input: 1_000_000, output: 0 },
      "9.000000",
    );
    const otherProject = await span(
      client,
      OTHER,
      "gpt-4o",
      { input: 1_000_000, output: 0 },
      "2.500000",
    );
    const datedEvent = await event(client, PROJECT, "gpt-4o-2024-08-06", 1_000_000, 0);

    const version = await saveModelPrice(
      PROJECT,
      "gpt-4o",
      { input: 1, output: 4, cachedInput: 0.5, cacheWrite: 2 },
      "user_1",
      db,
    );
    const result = await repriceProjectModel(PROJECT, "gpt-4o", version, db);

    assert.equal(await spanCost(client, plain), "1.000000");
    // 500k uncached at $1 + 1M cached at $0.50 + 500k written at $2.
    assert.equal(await spanCost(client, dated), "2.000000");
    assert.equal(await spanCost(client, mini), "9.000000");
    assert.equal(await spanCost(client, otherProject), "2.500000");
    assert.deepEqual(await eventCosts(client, datedEvent), ["1.000000", "1.000000"]);
    assert.deepEqual(result, { spans: 2, events: 1, stale: false });

    // A second run finds every row at its price and writes nothing.
    assert.deepEqual(await repriceProjectModel(PROJECT, "gpt-4o", version, db), {
      spans: 0,
      events: 0,
      stale: false,
    });

    // A reset puts the rows back on the built-in price.
    await deleteModelPrice(PROJECT, "gpt-4o", db);
    await repriceProjectModel(PROJECT, "gpt-4o", null, db);
    assert.equal(await spanCost(client, plain), "2.500000");
  } finally {
    await client.close();
  }
});

test("a re-price for an older save stops and leaves the rows to the newest save", async () => {
  const { client, db } = await setup();
  try {
    const row = await span(client, PROJECT, "my-own-model", { input: 1_000_000, output: 0 });
    const older = await saveModelPrice(
      PROJECT,
      "my-own-model",
      { input: 1, output: 1 },
      "user_1",
      db,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await saveModelPrice(
      PROJECT,
      "my-own-model",
      { input: 2, output: 2 },
      "user_1",
      db,
    );

    assert.deepEqual(await repriceProjectModel(PROJECT, "my-own-model", older, db), {
      spans: 0,
      events: 0,
      stale: true,
    });
    assert.equal(await spanCost(client, row), null);
    assert.deepEqual(await repriceProjectModel(PROJECT, "my-own-model", newer, db), {
      spans: 1,
      events: 0,
      stale: false,
    });
    assert.equal(await spanCost(client, row), "2.000000");
  } finally {
    await client.close();
  }
});

test("a run for gpt-4o never overwrites the rows a dated key saved meanwhile prices", async () => {
  const { client, db } = await setup();
  try {
    const dated = await span(
      client,
      PROJECT,
      "gpt-4o-2024-08-06",
      { input: 1_000_000, output: 0 },
      "2.500000",
    );
    const version = await saveModelPrice(PROJECT, "gpt-4o", { input: 1, output: 1 }, "user_1", db);
    // While the gpt-4o run reads its rows, an admin prices the dated id on its own.
    const result = await repriceProjectModel(PROJECT, "gpt-4o", version, db, {
      beforeWrite: async () => {
        await saveModelPrice(PROJECT, "gpt-4o-2024-08-06", { input: 7, output: 7 }, "user_2", db);
      },
    });
    // The dated rows belong to the newer, more specific key: the gpt-4o run leaves them.
    assert.equal(await spanCost(client, dated), "2.500000");
    assert.deepEqual(result, { spans: 0, events: 0, stale: false });
  } finally {
    await client.close();
  }
});

test("re-pricing stored costs restates rows that have a cost at the current prices, once", async () => {
  const { client, db } = await setup();
  try {
    // gpt-5.5: stored at the old $2.50 in, now $5 in. 100k in.
    const old = await span(client, PROJECT, "gpt-5.5", { input: 100_000, output: 0 }, "0.250000");
    const current = await span(
      client,
      PROJECT,
      "gpt-5.5",
      { input: 100_000, output: 0 },
      "0.500000",
    );
    const unpriced = await span(client, PROJECT, "gpt-5.5", { input: 100_000, output: 0 });
    // The old lookup priced any suffix; the current one prices only a date.
    const variant = await span(
      client,
      PROJECT,
      "gpt-5.5-turbo",
      { input: 100_000, output: 0 },
      "0.250000",
    );
    const oldEvent = await event(client, PROJECT, "gpt-5.5", 100_000, 0, null, "0.250000");
    const own = await span(
      client,
      PROJECT,
      "my-own-model",
      { input: 1_000_000, output: 1_000_000 },
      "9.000000",
    );
    await saveModelPrice(PROJECT, "my-own-model", { input: 1, output: 2 }, "user_1", db);

    const result = await repriceStored(db, { projectId: PROJECT });

    assert.equal(await spanCost(client, old), "0.500000");
    assert.equal(await spanCost(client, current), "0.500000");
    assert.equal(await spanCost(client, unpriced), null);
    assert.equal(await spanCost(client, variant), null);
    assert.equal(await spanCost(client, own), "3.000000");
    assert.deepEqual(await eventCosts(client, oldEvent), ["0.500000", "0.500000"]);
    assert.deepEqual([result.spans, result.events], [3, 1]);

    // A second run finds every row at its price and writes nothing.
    const again = await repriceStored(db, { projectId: PROJECT });
    assert.deepEqual([again.spans, again.events], [0, 0]);
  } finally {
    await client.close();
  }
});

test("a dry run writes nothing and totals the changes by organization and model", async () => {
  const { client, db } = await setup();
  try {
    const a = await span(client, PROJECT, "gpt-5.5", { input: 100_000, output: 0 }, "0.250000");
    await span(client, OTHER, "gpt-5.5", { input: 200_000, output: 0 }, "0.500000");
    await span(client, PROJECT, "gpt-5.5-turbo", { input: 100_000, output: 0 }, "0.250000");
    await span(client, ELSEWHERE, "gpt-5-mini", { input: 1_000_000, output: 0 }, "0.600000");
    await event(client, ELSEWHERE, "gpt-5-mini", 1_000_000, 0, null, "0.600000");

    const result = await repriceStored(db, { dryRun: true });

    assert.equal(await spanCost(client, a), "0.250000");
    assert.deepEqual([result.spans, result.events], [4, 1]);
    assert.deepEqual(result.changes, [
      {
        organizationId: ORG,
        organizationSlug: ORG,
        model: "gpt-5.5",
        table: "spans",
        rows: 2,
        unpricedNow: 0,
        oldUsd: 0.75,
        newUsd: 1.5,
      },
      {
        organizationId: ORG,
        organizationSlug: ORG,
        model: "gpt-5.5-turbo",
        table: "spans",
        rows: 1,
        unpricedNow: 1,
        oldUsd: 0.25,
        newUsd: 0,
      },
      {
        organizationId: OTHER_ORG,
        organizationSlug: OTHER_ORG,
        model: "gpt-5-mini",
        table: "events",
        rows: 1,
        unpricedNow: 0,
        oldUsd: 0.6,
        newUsd: 0.25,
      },
      {
        organizationId: OTHER_ORG,
        organizationSlug: OTHER_ORG,
        model: "gpt-5-mini",
        table: "spans",
        rows: 1,
        unpricedNow: 0,
        oldUsd: 0.6,
        newUsd: 0.25,
      },
    ]);
  } finally {
    await client.close();
  }
});

test("re-pricing stored costs leaves an excluded organization alone", async () => {
  const { client, db } = await setup();
  try {
    const kept = await span(client, PROJECT, "gpt-5.5", { input: 100_000, output: 0 }, "0.250000");
    const repriced = await span(
      client,
      ELSEWHERE,
      "gpt-5.5",
      { input: 100_000, output: 0 },
      "0.250000",
    );

    const result = await repriceStored(db, { excludeOrganizationIds: [ORG] });

    assert.equal(await spanCost(client, kept), "0.250000");
    assert.equal(await spanCost(client, repriced), "0.500000");
    assert.deepEqual([result.spans, result.events], [1, 0]);
  } finally {
    await client.close();
  }
});

test("re-pricing stored costs refuses an excluded organization that does not exist and writes nothing", async () => {
  const { client, db } = await setup();
  try {
    const row = await span(client, PROJECT, "gpt-5.5", { input: 100_000, output: 0 }, "0.250000");
    const missing = "22222222-2222-4222-8222-999999999999";

    await assert.rejects(
      repriceStored(db, { excludeOrganizationIds: [ORG, missing, "not-a-uuid"] }),
      (err: Error) =>
        err.message.includes(missing) &&
        err.message.includes("not-a-uuid") &&
        !err.message.includes(ORG),
    );
    assert.equal(await spanCost(client, row), "0.250000");
  } finally {
    await client.close();
  }
});

test("re-pricing stored costs repairs an event whose metric cost differs, in every mode", async () => {
  const { client, db } = await setup();
  try {
    // The event is at its current price; its metric was left behind.
    const stored = await event(client, PROJECT, "gpt-5.5", 100_000, 0, null, "0.500000");
    await client.query(`update event_metrics set cost_usd = 0.25 where event_id = $1`, [stored]);
    const unpriced = await event(client, PROJECT, "my-own-model", 100_000, 0);
    await client.query(`update event_metrics set cost_usd = 0.25 where event_id = $1`, [unpriced]);

    const result = await repriceStored(db, { projectId: PROJECT });
    assert.deepEqual(await eventCosts(client, stored), ["0.500000", "0.500000"]);
    assert.equal(result.events, 1);

    await repriceUnpriced(db, { projectId: PROJECT });
    assert.deepEqual(await eventCosts(client, unpriced), [null, null]);

    const again = await repriceStored(db, { projectId: PROJECT });
    assert.equal(again.events, 0);
  } finally {
    await client.close();
  }
});

test("re-pricing writes an event and its metric together or not at all", async () => {
  const { client, db } = await setup();
  try {
    const row = await event(client, PROJECT, "gpt-5.5", 100_000, 0, null, "0.250000");
    // The metric write fails after the event write.
    await client.exec(`
      create function fail_metric() returns trigger language plpgsql as $$ begin raise exception 'metric write failed'; end $$;
      create trigger fail_metric before update on event_metrics for each row execute function fail_metric();
    `);

    await assert.rejects(repriceStored(db, { projectId: PROJECT }), (err: Error) =>
      String(err.cause).includes("metric write failed"),
    );
    assert.deepEqual(await eventCosts(client, row), ["0.250000", "0.250000"]);
  } finally {
    await client.close();
  }
});
