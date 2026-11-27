import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMN_PROPERTIES } from "@/lib/contracts/trace-properties";
import { STANDARD_PROPERTIES } from "@/lib/ingest/properties/standard";
import { compileRql, type RqlCompileOptions } from "../compile";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const FROM = "2026-11-24T12:00:00.000Z";
const TO = "2026-11-25T12:00:00.000Z";
const WINDOW = `"started_at" >= $1::timestamptz and "started_at" < $2::timestamptz`;
const PROPERTIES = { indexed: ["organization", "plan", "org.id"], detected: ["tenant"] };

function compiled(text: string, options: Partial<RqlCompileOptions> = {}) {
  const result = compileRql(text, { now: NOW, properties: PROPERTIES, ...options });
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result;
}

function refused(text: string, options: Partial<RqlCompileOptions> = {}) {
  const result = compileRql(text, { now: NOW, properties: PROPERTIES, ...options });
  if (result.ok) assert.fail(`compiled: ${result.sql}`);
  return result.error;
}

test("properties['key'] in SELECT reads the key as a bound value", () => {
  const result = compiled("select trace_id, properties['organization'] from traces");
  assert.equal(
    result.sql,
    `select "trace_id" as "c1", ("properties" ->> $3::text) as "c2" from "rql"."traces" where ${WINDOW} limit $4::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "organization", 100]);
  assert.deepEqual(result.columns, [
    { name: "trace_id", type: "text" },
    { name: "organization", type: "text" },
  ]);
});

test("properties['key'] in WHERE, GROUP BY and ORDER BY is one parameter of the key", () => {
  const result = compiled(
    "select properties['plan'] as plan, count(*) as traces from traces where properties['organization'] = 'acme' and properties['plan'] in ('pro', 'team') group by properties['plan'] order by properties['plan'] desc",
  );
  assert.equal(
    result.sql,
    `select ("properties" ->> $3::text) as "c1", count(*) as "c2" from "rql"."traces" where ${WINDOW} and ((("properties" ->> $4::text) = $5::text) and (("properties" ->> $3::text) in ($6::text, $7::text))) group by ("properties" ->> $3::text) order by ("properties" ->> $3::text) desc limit $8::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "plan", "organization", "acme", "pro", "team", 100]);
});

test("GROUP BY and ORDER BY can name the alias of a property", () => {
  const result = compiled(
    "select properties['plan'] as plan, avg(duration_ms) as latency from traces group by plan order by plan",
  );
  assert.match(result.sql, /group by "c1" order by "c1" limit/);
});

test("events and scores read properties too; sessions and users have none", () => {
  for (const [table, time] of [
    ["events", "started_at"],
    ["scores", "trace_started_at"],
  ]) {
    const result = compiled(
      `select properties['organization'] as org, count(*) from ${table} group by org`,
    );
    assert.match(result.sql, new RegExp(`from "rql"."${table}" where "${time}"`));
    assert.match(result.sql, /\("properties" ->> \$3::text\)/);
  }
  for (const table of ["sessions", "users"]) {
    const error = refused(`select properties['organization'] from ${table}`);
    assert.equal(error.code, "unknown_column");
    assert.match(error.fix, /traces/);
  }
});

test("a property that is not indexed is refused with its name and the fix", () => {
  const detected = refused("select count(*) from traces where properties['tenant'] = 'x'");
  assert.equal(detected.code, "property_not_indexed");
  assert.match(detected.message, /tenant/);
  assert.match(detected.message, /not indexed/);
  assert.match(detected.fix, /index it in project settings/i);
  assert.ok(detected.at);

  const unknown = refused("select properties['organisation'] from traces");
  assert.equal(unknown.code, "property_not_indexed");
  assert.match(unknown.message, /organisation/);
  assert.match(unknown.fix, /Did you mean organization\?/);

  // With no indexed set, no property is indexed.
  const none = compileRql("select properties['organization'] from traces", { now: NOW });
  assert.ok(!none.ok);
  assert.equal(none.error.code, "property_not_indexed");
});

test("a check of the shape alone reads any name, and still refuses a column and a long name", () => {
  assert.ok(
    compileRql("select properties['tenant'] from traces", { now: NOW, properties: "any" }).ok,
  );
  for (const name of ["user", "k".repeat(101)]) {
    const result = compileRql(`select properties['${name}'] from traces`, {
      now: NOW,
      properties: "any",
    });
    assert.ok(!result.ok, name);
  }
});

test("a standard property that is a column is refused, with its column as the fix", () => {
  for (const [name, { rqlColumn }] of Object.entries(COLUMN_PROPERTIES)) {
    const error = refused(`select count(*) from traces where properties['${name}'] = 'x'`, {
      properties: { indexed: [name], detected: [] },
    });
    assert.equal(error.code, "property_is_column", name);
    assert.match(error.message, new RegExp(name));
    assert.match(error.fix, new RegExp(rqlColumn), name);
  }
  // The list of the contract is the one ingest keeps out of `properties`.
  assert.deepEqual(
    Object.keys(COLUMN_PROPERTIES).sort(),
    STANDARD_PROPERTIES.filter(({ column }) => column !== null)
      .map(({ name }) => name)
      .sort(),
  );
});

test("the map itself is not a value: bare properties and select * leave it out", () => {
  for (const text of [
    "select properties from traces",
    "select count(*) from traces where properties is not null",
    "select count(*) from traces group by properties",
  ]) {
    const error = refused(text);
    assert.equal(error.code, "wrong_arguments", text);
    assert.match(error.fix, /properties\['/);
  }
  const star = compiled("select * from traces");
  assert.ok(!star.columns.some(({ name }) => name === "properties"));
});

test("hostile keys: quotes, injection and odd characters are a bound value, or refused", () => {
  const keys = [
    "o'brien",
    "x'); drop table otel_trace_summaries; --",
    'a" or "1"="1',
    "org.id",
    "‮; reset role",
  ];
  for (const key of keys) {
    const literal = `'${key.replaceAll("'", "''")}'`;
    const result = compileRql(`select count(*) from traces where properties[${literal}] = 'v'`, {
      now: NOW,
      properties: { indexed: [key], detected: [] },
    });
    if (!result.ok) assert.fail(`${key}: ${result.error.message}`);
    assert.ok(result.params.includes(key), key);
    assert.ok(!result.sql.includes(key), key);
  }
});

test("a very long key is refused before it is looked up", () => {
  const key = "k".repeat(101);
  const error = refused(`select properties['${key}'] from traces`, {
    properties: { indexed: [key], detected: [] },
  });
  assert.equal(error.code, "wrong_arguments");
  assert.match(error.message, /100 characters/);
});

test("a key that is not a text literal is refused", () => {
  for (const text of [
    "select properties[trace_id] from traces",
    "select properties[1] from traces",
    'select properties["organization"] from traces',
    "select properties[''] from traces",
    "select properties['organi' || 'zation'] from traces",
  ]) {
    const error = compileRql(text, { now: NOW, properties: PROPERTIES });
    assert.ok(!error.ok, text);
    assert.match(error.error.fix, /single quotes|properties\['/, text);
  }
});

test("a key written as an identifier gets the fix of the subscript", () => {
  const error = refused("select properties.organization from traces");
  assert.match(error.fix, /properties\['organization'\]/);
});

test("the page filter of a property keeps the rows whose trace holds one of its values", () => {
  const traces = compiled("select count(*) from traces", {
    filter: { properties: { organization: ["acme", " globex "], plan: ["pro"] } },
  });
  assert.equal(
    traces.sql,
    `select count(*) as "c1" from "rql"."traces" where ${WINDOW} and ("properties" ->> $3::text) in ($4::text, $5::text) and ("properties" ->> $6::text) in ($7::text) limit $8::bigint`,
  );
  assert.deepEqual(traces.params, [FROM, TO, "organization", "acme", "globex", "plan", "pro", 100]);
  const events = compiled("select count(*) from events", {
    filter: { and: [{ properties: { organization: ["acme"] } }] },
  });
  assert.match(
    events.sql,
    /"trace_id" in \(select "trace_id" from "rql"."traces" where \("properties" ->> \$3::text\) in \(\$4::text\)\)/,
  );
});
