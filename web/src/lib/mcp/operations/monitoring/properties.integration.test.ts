import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { changeTraceProperty } from "@/lib/ingest/properties/actions";
import { listTraceProperties, recordPropertyKeys } from "@/lib/ingest/properties/store";
import { tracePropertyStorage } from "@/lib/synthesis/traces/property-storage";
import { propertyReadOperations, propertyWriteOperations } from "./properties";
import {
  KEY_AUTH,
  type Monitoring,
  monitoring,
  ORG,
  OTHER,
  PROJECT,
  personAuth,
} from "./test-support";

/**
 * The trace property tools over a real database (RTL-395): the same action as the console's
 * server action, behind the same flag and admin check, and one project's keys and values never
 * reach another project, through the tools, the settings loader or the action.
 */

let m: Monitoring;
const limit = { value: Number.POSITIVE_INFINITY };
before(async () => {
  m = await monitoring((deps) => [
    ...propertyReadOperations(deps),
    ...propertyWriteOperations(deps, {
      storage: (db) => ({
        ...tracePropertyStorage(db, () => {}),
        indexLimit: () => limit.value,
      }),
      organization: async () => ({ id: ORG }),
    }),
  ]);
});
beforeEach(async () => {
  await m.client.exec(
    "delete from trace_property_keys; delete from jobs; delete from otel_trace_summaries",
  );
  await recordPropertyKeys(
    PROJECT,
    [
      { name: "app.plan", source: "user", count: 4 },
      { name: "organization", source: "standard", count: 2 },
      { name: "user", source: "standard", count: 2 },
    ],
    m.db,
  );
  await m.client.exec(`
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
      input_tokens, output_tokens, cost_usd, spans_max_received_at, properties)
    values ('${PROJECT}', 't1', now(), 1, false, 0, 0, 0, now(), '{"organization":"acme"}'),
      ('${OTHER}', 't2', now(), 1, false, 0, 0, 0, now(), '{"organization":"acme"}');
  `);
  m.set.on = true;
  limit.value = Number.POSITIVE_INFINITY;
  m.events.length = 0;
});
after(() => m.client.close());

const change = (params: object, auth = personAuth()) =>
  m.call("change_trace_property", { projectId: PROJECT, ...params }, auth);

test("list_trace_properties lists each property with its state and source", async () => {
  const listed = await m.data<{ summary: string; rows: Array<Record<string, unknown>> }>(
    "list_trace_properties",
  );
  assert.equal(listed.summary, "3 trace properties, 2 indexed: organization, user.");
  assert.deepEqual(
    listed.rows.map(({ name, state, source, column, valuesStored }) => ({
      name,
      state,
      source,
      column,
      valuesStored,
    })),
    [
      {
        name: "organization",
        state: "indexed",
        source: "standard",
        column: null,
        valuesStored: true,
      },
      {
        name: "user",
        state: "indexed",
        source: "standard",
        column: "end_user_id",
        valuesStored: false,
      },
      { name: "app.plan", state: "detected", source: "user", column: null, valuesStored: false },
    ],
  );
});

test("an admin indexes, stops and erases through MCP; a member and a key cannot", async () => {
  for (const auth of [personAuth("member"), KEY_AUTH]) {
    const refused = await change({ action: "index", name: "app.plan" }, auth);
    assert.equal(!refused.ok && refused.error, "forbidden");
  }
  const indexed = await change({ action: "index", name: "app.plan" });
  assert.ok(indexed.ok, JSON.stringify(indexed));
  assert.deepEqual(
    (indexed.data as { property: { state: string }; filling: boolean }).filling,
    true,
  );
  const jobs = await m.client.query<{ kind: string; payload: unknown }>(
    "select kind, payload from jobs where project_id = $1",
    [PROJECT],
  );
  assert.deepEqual(jobs.rows, [
    { kind: "fill_trace_properties", payload: { names: ["app.plan"] } },
  ]);
  assert.equal(m.events.at(-1)?.event, "project_settings_updated");

  const stopped = await change({ action: "stop", name: "organization", erase: true });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.deepEqual((stopped.data as { erased: object }).erased, { spans: 0, traces: 1 });
  const { rows } = await m.client.query<{ project_id: string; properties: unknown }>(
    "select project_id, properties from otel_trace_summaries order by project_id",
  );
  // The other project keeps its value.
  assert.deepEqual(rows, [
    { project_id: PROJECT, properties: {} },
    { project_id: OTHER, properties: { organization: "acme" } },
  ]);
  const column = await change({ action: "stop", name: "user" });
  assert.equal(!column.ok && column.error, "invalid_params");
  const misplaced = await change({ action: "index", name: "app.plan", erase: true });
  assert.equal(!misplaced.ok && misplaced.error, "invalid_params");
});

test("without the entitlement the index is refused as a quota, with the reason and the limit", async () => {
  limit.value = 0;
  const refused = await change({ action: "index", name: "app.plan" });
  assert.equal(!refused.ok && refused.error, "quota_exceeded");
  assert.equal(!refused.ok && refused.reason, "not_on_plan");
  assert.match(refused.ok ? "" : refused.message, /needs a paid plan: this plan indexes 0/);
  // A standard property is not a plan feature.
  await change({ action: "stop", name: "organization" });
  assert.ok((await change({ action: "index", name: "organization" })).ok);
});

test("with the flag off both tools refuse", async () => {
  m.set.on = false;
  for (const [id, params] of [
    ["list_trace_properties", {}],
    ["change_trace_property", { action: "index", name: "app.plan" }],
  ] as const) {
    const result = await m.call(id, { projectId: PROJECT, ...params }, personAuth());
    assert.equal(!result.ok && result.reason, "custom_monitoring_off", id);
  }
  assert.equal((await listTraceProperties(PROJECT, m.db))[2]?.state, "detected");
});

test("tenant: project A's keys and values do not reach project B", async () => {
  // The tools.
  const listed = await m.call("list_trace_properties", { projectId: OTHER }, personAuth());
  assert.ok(listed.ok);
  assert.deepEqual((listed.data as { rows: unknown[] }).rows, []);
  const indexed = await m.call(
    "change_trace_property",
    { projectId: OTHER, action: "index", name: "app.plan" },
    personAuth(),
  );
  assert.equal(!indexed.ok && indexed.error, "not_found");
  const erased = await m.call(
    "change_trace_property",
    { projectId: OTHER, action: "erase", name: "organization" },
    personAuth(),
  );
  assert.equal(!erased.ok && erased.error, "not_found");
  // A key bound to project A cannot reach B at all.
  const keyed = await m.call("list_trace_properties", { projectId: OTHER });
  assert.equal(!keyed.ok && keyed.error, "forbidden");
  // The settings loader.
  assert.deepEqual(await listTraceProperties(OTHER, m.db), []);
  // The console's action, as its server action calls it, for project B.
  const action = await changeTraceProperty(
    OTHER,
    { action: "index", name: "app.plan" },
    {
      ...tracePropertyStorage(m.db, () => {}),
      findProjectScope: async (id) => ({
        project: { id },
        organization: { id: ORG },
        role: "admin",
      }),
      enabled: async () => true,
      isRestricted: async () => false,
      observe: async () => {},
    },
  );
  assert.deepEqual(action, {
    ok: false,
    reason: "not_found",
    error: "This project's traces carry no property app.plan.",
  });
  assert.equal((await listTraceProperties(PROJECT, m.db))[2]?.state, "detected");
});
