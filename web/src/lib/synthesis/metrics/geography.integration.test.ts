import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type GeographyQuery, geographyQuery } from "@/lib/contracts/query";
import { type GeographyResult, runGeography } from "@/lib/synthesis/metrics/geography";
import { runQuery } from "@/lib/synthesis/metrics/query";
import { PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import "@/lib/views/scorers/metrics";

/**
 * t1 US-CA prod    error  t2 US-CA prod    t3 US-NY staging  t4 US prod, no region
 * t5 IT    prod           t6 no place, prod                  t7 US-CA, outside the window
 */

const POLITE = "44444444-4444-4444-8444-444444444444";
const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const trace = (id: string, place: string | null, environment = "prod", more: object = {}) => {
    const [country, region] = place?.split("-") ?? [];
    return {
      id,
      startedAt: "2026-11-02T09:00:00Z",
      root: {
        ...more,
        attributes: {
          "deployment.environment.name": environment,
          ...(country ? { "ratel.geo.country": country } : {}),
          ...(region ? { "ratel.geo.region": `${country}-${region}` } : {}),
        },
      },
    };
  };
  await database.seed([
    trace("t1", "US-CA", "prod", { statusCode: 2 }),
    trace("t2", "US-CA"),
    trace("t3", "US-NY", "staging"),
    trace("t4", "US"),
    trace("t5", "IT"),
    trace("t6", null),
    { ...trace("t7", "US-CA"), startedAt: "2026-11-03T00:00:00Z" },
  ]);
  await database.client.exec(`
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by) values
      ('${POLITE}', '${PROJECT}', 'Polite', 'judge', '{}', 'a', 'a');
    insert into trace_scores (project_id, scorer_id, trace_id, value, passed, trace_started_at) values
      ('${PROJECT}', '${POLITE}', 't1', 0, false, '2026-11-02'),
      ('${PROJECT}', '${POLITE}', 't2', 1, true, '2026-11-02'),
      ('${PROJECT}', '${POLITE}', 't5', 1, true, '2026-11-02');
  `);
});

after(() => database.client.close());

test("the value per country, highest first, and how many traces have a place", async () => {
  const result = await run(geographyQuery("trace_count", "count"));
  assert.deepEqual(drawn(result), ["US 4", "IT 1"]);
  assert.deepEqual(result.located, { traces: 5, matched: 6 });
});

test("the value per region of one country", async () => {
  const result = await run(geographyQuery("trace_count", "count", { country: "US" }));
  assert.deepEqual(drawn(result), ["US-CA 2", "US-NY 1"]);
  assert.deepEqual(result.located, { traces: 3, matched: 4 });
  const france = await run(geographyQuery("trace_count", "count", { country: "FR" }));
  assert.deepEqual([france.places, france.located], [[], { traces: 0, matched: 0 }]);
});

test("a rate, and a scorer's pass rate", async () => {
  assert.deepEqual(drawn(await run(geographyQuery("error_rate", "rate"))), ["US 0.25", "IT 0"]);
  const passRate = geographyQuery("scorer_pass_rate", "rate", {
    filters: { scorer: { id: POLITE } },
  });
  assert.deepEqual(drawn(await run(passRate)), ["IT 1", "US 0.5"]);
});

test("the query's filter and the dashboard's must both match, per country and per region", async () => {
  const prod = { filters: { environments: ["prod"] } };
  assert.deepEqual(drawn(await run(geographyQuery("trace_count", "count", prod))), [
    "US 3",
    "IT 1",
  ]);
  assert.deepEqual(
    drawn(await run(geographyQuery("trace_count", "count", { ...prod, country: "US" }))),
    ["US-CA 2"],
  );
  const both = await run(geographyQuery("trace_count", "count", prod), {
    filter: { environments: ["staging"] },
  });
  assert.deepEqual([both.places, both.located], [[], { traces: 0, matched: 0 }]);
});

test("the result says whether addresses are resolved", async () => {
  const query = geographyQuery("trace_count", "count");
  assert.equal((await run(query)).resolvesAddresses, false);
  const on = await runGeography(PROJECT, query, SCOPE, database.db, async () => true);
  assert.equal(on.resolvesAddresses, true);
});

function run(query: GeographyQuery, scope: object = {}) {
  return runQuery(PROJECT, query, { ...SCOPE, ...scope }, database.db);
}

function drawn({ places }: GeographyResult) {
  return places.map(({ code, value }) => `${code} ${value}`);
}
