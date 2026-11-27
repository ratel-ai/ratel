import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { loadPropertyChoices } from "./property-choices";

/**
 * What the Filter and Group by dropdowns offer (RTL-396): the project's indexed properties with
 * their most frequent values in the range, and its detected ones. Never another project's.
 */

const OTHER = "33333333-3333-4333-8333-333333333333";
const RANGE = { since: new Date("2026-11-01T00:00:00Z"), until: new Date("2026-11-08T00:00:00Z") };

async function seeded() {
  const setup = await setupDb();
  const traces: [string, string, string, Record<string, string>][] = [
    [PROJECT_ID, "t1", "2026-11-02T10:00:00Z", { organization: "acme", plan: "pro" }],
    [PROJECT_ID, "t2", "2026-11-02T11:00:00Z", { organization: "acme", plan: "team" }],
    [PROJECT_ID, "t3", "2026-11-03T10:00:00Z", { organization: "globex", plan: "pro" }],
    // Outside the range.
    [PROJECT_ID, "t4", "2026-10-20T10:00:00Z", { organization: "initech" }],
    // Another project, with the same names.
    [OTHER, "o1", "2026-11-02T10:00:00Z", { organization: "hooli", plan: "enterprise" }],
  ];
  await setup.client.exec(`
    insert into projects (id, organization_id, name, slug)
    values ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT_ID}', 'organization', 'indexed', 'standard', 9),
      ('${PROJECT_ID}', 'plan', 'indexed', 'user', 5),
      ('${PROJECT_ID}', 'tenant', 'detected', 'user', 3),
      ('${PROJECT_ID}', 'release', 'detected', 'standard', 2),
      ('${PROJECT_ID}', 'user', 'indexed', 'standard', 7),
      ('${OTHER}', 'secret', 'indexed', 'user', 99),
      ('${OTHER}', 'hidden', 'detected', 'user', 99);
  `);
  for (const [project, trace, at, properties] of traces)
    await setup.client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, properties)
       values ($1, $2, $3, 10, false, 0, 0, 0, $3, $3, $4::jsonb)`,
      [project, trace, at, JSON.stringify(properties)],
    );
  return setup;
}

test("the dropdowns offer this project's indexed properties with their frequent values, and its detected ones", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  const choices = await loadPropertyChoices(PROJECT_ID, RANGE, {
    db,
    entitled: false,
    upgradeHref: "/org/acme/billing",
  });
  assert.deepEqual(choices, {
    indexed: [
      {
        name: "organization",
        values: [
          { value: "acme", count: 2 },
          { value: "globex", count: 1 },
        ],
      },
      {
        name: "plan",
        values: [
          { value: "pro", count: 2 },
          { value: "team", count: 1 },
        ],
      },
    ],
    detected: [
      { name: "tenant", source: "user" },
      { name: "release", source: "standard" },
    ],
    entitled: false,
    upgradeHref: "/org/acme/billing",
  });
  // The other project sees only its own.
  const other = await loadPropertyChoices(OTHER, RANGE, { db, entitled: true, upgradeHref: null });
  assert.deepEqual(other.indexed, [{ name: "secret", values: [] }]);
  assert.deepEqual(other.detected, [{ name: "hidden", source: "user" }]);
  assert.deepEqual(await loadStoredPropertyNames(PROJECT_ID, db), {
    indexed: ["organization", "plan"],
    detected: ["tenant", "release"],
  });
});

test("the values are the 50 most frequent of the range, in one query", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  for (let i = 0; i < 60; i += 1)
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, properties)
       values ($1, $2, '2026-11-04T10:00:00Z', 10, false, 0, 0, 0, now(), now(), $3::jsonb)`,
      [PROJECT_ID, `many-${i}`, JSON.stringify({ plan: `p${String(i).padStart(2, "0")}` })],
    );
  let queries = 0;
  const counted = new Proxy(db, {
    get(target, key, receiver) {
      if (key === "execute") {
        return (...args: unknown[]) => {
          queries += 1;
          return (target.execute as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const choices = await loadPropertyChoices(PROJECT_ID, RANGE, {
    db: counted,
    entitled: true,
    upgradeHref: null,
  });
  const plan = choices.indexed.find(({ name }) => name === "plan");
  assert.equal(plan?.values.length, 50);
  assert.deepEqual(plan?.values[0], { value: "pro", count: 2 });
  assert.equal(queries, 1);
});
