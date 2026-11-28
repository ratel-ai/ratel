import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { QUERY_VERSION } from "@/lib/contracts/query";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { describeRqlSchema, RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { createDashboard, getDashboards } from "@/lib/views/dashboards/store";
import type { Widget } from "@/lib/views/dashboards/types";
import type { AskRequest } from "./domain";
import { type DraftDeps, draftWidgets, NOT_SET_UP } from "./draft";
import { ASK_LIMITS, ASK_MODEL } from "./limits";
import type { AskModel } from "./model";
import { askRequests } from "./schema";
import { setAskOutcome } from "./store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-24T12:00:00Z");
const PERSON = "user_1";

const GOOD = {
  title: "Traces per hour",
  rql: "select time_bucket('1 hour', started_at) as hour, count(*) as traces from traces group by hour order by hour",
  chart: "line",
};
const BROKEN = { title: "Cost of nothing", rql: "select nothing from nowhere", chart: "bar" };
const FIXED = {
  title: "Cost of nothing",
  rql: "select model, sum(cost_usd) as cost from events where type = 'llm_call' group by model",
  chart: "bar",
};

// Values that exist in the database but must never reach the model.
const TRACE_ID = "f".repeat(32);
const PROPERTY_VALUE = "enterprise-plan-value-7731";
const OTHER_TITLE = "Other project secret widget";
const OTHER_WORDS = "other project secret words";

let client: PGlite;
let db: ReturnType<typeof getDb>;

beforeEach(async () => {
  client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 5),
      ('${PROJECT}', 'region', 'detected', 'user', 3),
      ('${OTHER}', 'other_only_property', 'indexed', 'user', 9);
  `);
  await client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, properties)
     values ($1, $2, $3, 100, false, 1, 1, 0, $3, $3, $4)`,
    [PROJECT, TRACE_ID, new Date(NOW.getTime() - 3_600_000), { plan: PROPERTY_VALUE }],
  );
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
});

/** A model that answers from a script, and keeps each request. */
function fakeModel(...answers: (object | Error)[]): AskModel & { requests: AskRequest[] } {
  const requests: AskRequest[] = [];
  return {
    model: ASK_MODEL,
    standIn: false,
    requests,
    async complete(request) {
      requests.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("no more answers");
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(answer), usage: { inputTokens: 1_000, outputTokens: 200 } };
    },
  };
}

function deps(model: AskModel | null): DraftDeps {
  return { model, db: db as never, now: () => NOW };
}

const ask = (over: Partial<Parameters<typeof draftWidgets>[0]> = {}) => ({
  projectId: PROJECT,
  actor: PERSON,
  surface: "console" as const,
  target: "dashboard" as const,
  dashboardId: null,
  words: "How are my agents doing?",
  ...over,
});

function widget(title: string, text: string): Widget {
  return {
    id: crypto.randomUUID(),
    title,
    query: { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
    chart: "table",
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

async function asks() {
  return db.select().from(askRequests).orderBy(askRequests.createdAt);
}

test("a broken widget is repaired once, then refused with its reason; the good ones are kept and nothing is saved", async () => {
  const model = fakeModel({ widgets: [GOOD, BROKEN] }, { widgets: [BROKEN] });
  const result = await draftWidgets(ask(), deps(model));
  assert.equal(result.status, "drafted");
  if (result.status !== "drafted") return;
  assert.deepEqual(
    result.widgets.map(({ title, chart }) => ({ title, chart })),
    [{ title: GOOD.title, chart: "line" }],
  );
  assert.equal(result.widgets[0]?.query.text, GOOD.rql);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0]?.title, BROKEN.title);
  assert.match(result.refused[0]?.reason ?? "", /nowhere/);
  assert.equal(model.requests.length, 2, "one repair round");
  assert.match(model.requests[1]?.user ?? "", /were refused/);
  // No dashboard and no widget is saved: only the ask, with its draft.
  assert.deepEqual(await getDashboards(PROJECT, undefined, db), []);
  const [stored] = await asks();
  assert.equal(stored?.words, "How are my agents doing?");
  assert.equal(stored?.outcome, null);
  assert.deepEqual(stored?.draft, { widgets: result.widgets, refused: result.refused });
  assert.ok((stored?.usd ?? 0) > 0);
});

test("the repair round's fixed widget joins the draft", async () => {
  const model = fakeModel({ widgets: [GOOD, BROKEN] }, { widgets: [FIXED] });
  const result = await draftWidgets(ask(), deps(model));
  assert.equal(result.status, "drafted");
  if (result.status !== "drafted") return;
  assert.deepEqual(
    result.widgets.map(({ title }) => title),
    [GOOD.title, FIXED.title],
  );
  assert.deepEqual(result.refused, []);
});

test("a widget ask gives one widget at most", async () => {
  const model = fakeModel({ widgets: [GOOD, FIXED] });
  const result = await draftWidgets(ask({ target: "widget" }), deps(model));
  assert.equal(result.status, "drafted");
  if (result.status !== "drafted") return;
  assert.equal(result.widgets.length, 1);
  assert.equal(model.requests.length, 1);
});

test("the request holds the catalog, the indexed names, the widgets, the earlier asks and the words, and nothing else", async () => {
  const own = await createDashboard(
    {
      projectId: PROJECT,
      name: "Costs",
      widgets: [
        widget(
          "Cost per day",
          "select time_bucket('1 day', started_at) as day, sum(cost_usd) as cost from traces group by day",
        ),
      ],
      updatedBy: PERSON,
      updatedByName: null,
    },
    db,
  );
  await createDashboard(
    {
      projectId: OTHER,
      name: "Other",
      widgets: [widget(OTHER_TITLE, "select count(*) as other_project_count from traces")],
      updatedBy: PERSON,
      updatedByName: null,
    },
    db,
  );
  // An earlier ask here, and one of the other project.
  await draftWidgets(ask({ words: "cost by model" }), deps(fakeModel({ widgets: [FIXED] })));
  await draftWidgets(
    ask({ projectId: OTHER, words: OTHER_WORDS, actor: "user_2" }),
    deps(fakeModel({ widgets: [GOOD] })),
  );
  const [earlier] = await db.select().from(askRequests).where(eq(askRequests.projectId, PROJECT));
  assert.ok(earlier);
  await setAskOutcome(PROJECT, earlier.id, "kept", NOW, db);

  const model = fakeModel({ widgets: [GOOD] });
  const range = { from: "2026-11-17T12:00:00.000Z", to: NOW.toISOString() };
  await draftWidgets(ask({ words: "Show me errors", range }), deps(model));
  const request = model.requests[0];
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.user), {
    target: "dashboard",
    words: "Show me errors",
    maxWidgets: 8,
    range,
    rql: JSON.parse(JSON.stringify(describeRqlSchema({ indexed: ["plan"] }))),
    dashboardWidgets: [],
    otherDashboardWidgets: [
      {
        dashboard: "Costs",
        title: "Cost per day",
        rql: "select time_bucket('1 day', started_at) as day, sum(cost_usd) as cost from traces group by day",
      },
    ],
    earlierAsks: [
      { target: "dashboard", words: "cost by model", outcome: "kept", widgets: [FIXED.title] },
    ],
  });
  const sent = request.system + request.user;
  for (const absent of [
    TRACE_ID,
    PROPERTY_VALUE,
    OTHER_TITLE,
    OTHER_WORDS,
    "other_only_property",
    "region",
  ])
    assert.ok(!sent.includes(absent), `the request holds ${absent}`);

  // A widget ask for a dashboard holds that dashboard's widgets, and no other dashboard's.
  const forWidget = fakeModel({ widgets: [GOOD] });
  await draftWidgets(
    ask({ target: "widget", dashboardId: own?.id ?? null, words: "latency" }),
    deps(forWidget),
  );
  const payload = JSON.parse(forWidget.requests[0]?.user ?? "{}");
  assert.deepEqual(
    payload.dashboardWidgets.map((w: { title: string }) => w.title),
    ["Cost per day"],
  );
  assert.deepEqual(payload.otherDashboardWidgets, []);
});

test("no model key gives not_set_up and stores nothing", async () => {
  const result = await draftWidgets(ask(), deps(null));
  assert.deepEqual(result, { status: "not_set_up", message: NOT_SET_UP });
  assert.deepEqual(await asks(), []);
});

test("words that are empty or too long are refused before any call", async () => {
  const model = fakeModel();
  assert.equal((await draftWidgets(ask({ words: "  " }), deps(model))).status, "invalid");
  assert.equal(
    (await draftWidgets(ask({ words: "x".repeat(501) }), deps(model))).status,
    "invalid",
  );
  assert.equal(model.requests.length, 0);
});

test("a failed call gives failed, keeps its reservation and stores no draft", async () => {
  const result = await draftWidgets(ask(), deps(fakeModel(new Error("boom"))));
  assert.equal(result.status, "failed");
  const [stored] = await asks();
  assert.equal(stored?.draft, null);
  assert.ok((stored?.usd ?? 0) > 0);
});

async function insertAsks(count: number, over: { actor?: string; usd?: number; at?: Date } = {}) {
  const at = over.at ?? new Date(NOW.getTime() - 3_600_000);
  await db.insert(askRequests).values(
    Array.from({ length: count }, () => ({
      projectId: OTHER,
      actor: over.actor ?? "someone",
      surface: "console" as const,
      target: "widget" as const,
      words: "w",
      model: ASK_MODEL,
      usd: over.usd ?? 0,
      createdAt: at,
    })),
  );
}

test(`the organization stops at ${ASK_LIMITS.draftsPerOrgPerDay} drafts a day, until the next UTC day`, async () => {
  await insertAsks(ASK_LIMITS.draftsPerOrgPerDay - 1);
  // Yesterday's asks do not count.
  await insertAsks(5, { at: new Date("2026-11-23T20:00:00Z") });
  assert.equal((await draftWidgets(ask(), deps(fakeModel({ widgets: [GOOD] })))).status, "drafted");
  const model = fakeModel({ widgets: [GOOD] });
  const result = await draftWidgets(ask(), deps(model));
  assert.equal(result.status, "limited");
  if (result.status !== "limited") return;
  assert.equal(result.limit, "org_daily_drafts");
  assert.equal(result.resetsAt, "2026-11-25T00:00:00.000Z");
  assert.match(result.message, /200 drafts today/);
  assert.equal(model.requests.length, 0);
});

test(`one person stops at ${ASK_LIMITS.draftsPerPersonPerMinute} drafts a minute, until the oldest is a minute old`, async () => {
  const oldest = new Date(NOW.getTime() - 50_000);
  await insertAsks(1, { actor: PERSON, at: oldest });
  await insertAsks(ASK_LIMITS.draftsPerPersonPerMinute - 1, {
    actor: PERSON,
    at: new Date(NOW.getTime() - 10_000),
  });
  // Another person still may.
  assert.equal(
    (await draftWidgets(ask({ actor: "user_2" }), deps(fakeModel({ widgets: [GOOD] })))).status,
    "drafted",
  );
  const result = await draftWidgets(ask(), deps(fakeModel({ widgets: [GOOD] })));
  assert.equal(result.status, "limited");
  if (result.status !== "limited") return;
  assert.equal(result.limit, "person_per_minute");
  assert.equal(result.resetsAt, new Date(oldest.getTime() + 60_000).toISOString());
});

test(`the drafts of an organization stop at ${ASK_LIMITS.usdPerOrgPerDay} USD a day`, async () => {
  await insertAsks(1, { usd: ASK_LIMITS.usdPerOrgPerDay - 0.000001 });
  const model = fakeModel({ widgets: [GOOD] });
  const result = await draftWidgets(ask(), deps(model));
  assert.equal(result.status, "limited");
  if (result.status !== "limited") return;
  assert.equal(result.limit, "org_daily_spend");
  assert.equal(result.resetsAt, "2026-11-25T00:00:00.000Z");
  assert.match(result.message, /model budget of 5 USD/);
  assert.equal(model.requests.length, 0);
});

test("the outcome of an ask is set to kept, edited or discarded, for its own project only", async () => {
  for (const outcome of ["kept", "edited", "discarded"] as const) {
    const result = await draftWidgets(
      ask({ words: outcome }),
      deps(fakeModel({ widgets: [GOOD] })),
    );
    assert.equal(result.status, "drafted");
    if (result.status !== "drafted") return;
    assert.equal(await setAskOutcome(OTHER, result.askId, outcome, NOW, db), false);
    assert.equal(await setAskOutcome(PROJECT, result.askId, outcome, NOW, db), true);
    const [row] = await db.select().from(askRequests).where(eq(askRequests.id, result.askId));
    assert.equal(row?.outcome, outcome);
  }
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(askRequests)
    .where(sql`${askRequests.outcome} is not null`);
  assert.equal(count, 3);
});
