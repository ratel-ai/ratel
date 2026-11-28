import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, describeRqlSchema } from "../compile";
import { RQL_FUNCTIONS, RQL_TABLES } from "../domain/catalog";
import { RQL_KEYWORDS, rqlCompletions, rqlEditorData } from "../domain/editor";

const NOW = new Date("2026-11-25T12:00:00.000Z");

test("the editor data has every table, column and function of the catalog, and nothing else", () => {
  const data = rqlEditorData();
  const pairs = (
    tables: readonly { name: string; columns: readonly { name: string; type: string }[] }[],
  ) =>
    tables.flatMap((table) => [
      table.name,
      ...table.columns.map((c) => `${table.name}.${c.name}:${c.type}`),
    ]);
  assert.deepEqual(pairs(data.tables), pairs(RQL_TABLES));
  assert.deepEqual(
    data.functions.map((fn) => `${fn.name} ${fn.signature}`),
    RQL_FUNCTIONS.map((fn) => `${fn.name} ${fn.signature}`),
  );
});

test("the editor and describe_rql_schema read one catalog: the same names and operators", () => {
  const data = rqlEditorData();
  const schema = describeRqlSchema();
  assert.deepEqual(
    data.tables.map((t) => [t.name, t.columns.map((c) => c.name)]),
    schema.tables.map((t) => [t.name, t.columns.map((c) => c.name)]),
  );
  assert.deepEqual(
    data.functions.map((fn) => fn.name),
    schema.functions.map((fn) => fn.name),
  );
  assert.deepEqual(data.operators, schema.operators);
});

test("every keyword the editor offers compiles", () => {
  const query = `select distinct service_name as s from traces where not has_error and (duration_ms between 1 and 2 or service_name in ('a') or service_name like 'a%' or service_name ilike 'a%' or session_id is null or has_error is true or has_error = false) group by s having count(*) > 0 order by s asc nulls first limit 5`;
  const second = "select service_name from traces order by service_name desc nulls last";
  const words = new Set(`${query} ${second}`.toLowerCase().split(/[^a-z]+/));
  for (const keyword of RQL_KEYWORDS)
    for (const word of keyword.split(" ")) assert.ok(words.has(word), keyword);
  for (const text of [query, second]) {
    const result = compileRql(text, { now: NOW });
    assert.ok(result.ok, result.ok ? "" : result.error.message);
  }
});

const at = (text: string) => {
  const pos = text.indexOf("|");
  return rqlCompletions(text.replace("|", ""), pos, true);
};
const labels = (text: string) => at(text)?.options.map((option) => option.label) ?? null;

test("after FROM the editor offers the tables only", () => {
  assert.deepEqual(
    labels("select count(*) from |"),
    RQL_TABLES.map((t) => t.name),
  );
  assert.deepEqual(
    labels("select count(*) from tr|"),
    RQL_TABLES.map((t) => t.name),
  );
  assert.equal(at("select count(*) from tr|")?.from, 21);
});

test("the columns are those of the table in FROM, with the functions, keywords and operators", () => {
  const options = labels("select | from scores") ?? [];
  const scores = RQL_TABLES.find((t) => t.name === "scores");
  assert.ok(scores);
  for (const column of scores.columns) assert.ok(options.includes(column.name), column.name);
  assert.ok(
    !options.includes("duration_ms") || scores.columns.some((c) => c.name === "duration_ms"),
  );
  for (const word of ["count", "rate", "each", "select", "group by", "like"])
    assert.ok(options.includes(word), word);
  // No FROM yet: every column of every table, once.
  const all = labels("select |") ?? [];
  assert.equal(all.filter((name) => name === "trace_id").length, 1);
  assert.ok(all.includes("duration_ms") && all.includes("scorer"));
});

test("a function has its signature and description; a column its type and description", () => {
  const options = at("select | from traces")?.options ?? [];
  const rate = options.find((o) => o.label === "rate");
  const fn = RQL_FUNCTIONS.find((f) => f.name === "rate");
  assert.ok(fn);
  assert.deepEqual(
    [rate?.type, rate?.detail, rate?.info],
    ["function", fn.signature, fn.description],
  );
  const duration = options.find((o) => o.label === "duration_ms");
  assert.equal(duration?.type, "property");
  assert.match(duration?.detail ?? "", /number/);
});

test("nothing the compiler refuses: no Postgres function, nothing in a string or a comment", () => {
  const options = labels("select | from traces") ?? [];
  for (const refused of ["now", "date_trunc", "case", "join", "union", "with", "offset", "cast"])
    assert.ok(!options.includes(refused), refused);
  assert.equal(at("select count(*) from traces where service_name = 'tr|'"), null);
  assert.equal(at("select count(*) from traces -- tr|"), null);
  // While typing a word, without asking, only a word starts a list.
  assert.equal(rqlCompletions("select count(*) ", 16, false), null);
});

test("inside properties[' the editor offers the project's properties: the detected ones off", () => {
  const data = rqlEditorData({ indexed: ["organization", "plan"], detected: ["tenant"] });
  assert.deepEqual(data.properties, { indexed: ["organization", "plan"], detected: ["tenant"] });
  // The catalog part stays the static one.
  assert.deepEqual(data.tables, rqlEditorData().tables);
  const text = "select count(*) from traces where properties['pl";
  const found = rqlCompletions(text, text.length, false, data);
  assert.equal(found?.from, text.length - 2);
  assert.deepEqual(
    found?.options.map(({ label, disabled }) => [label, Boolean(disabled)]),
    [
      ["organization", false],
      ["plan", false],
      ["tenant", true],
    ],
  );
  const tenant = found?.options.find(({ label }) => label === "tenant");
  assert.match(tenant?.detail ?? "", /not indexed/);
  assert.match(tenant?.info ?? "", /index it in project settings/i);
  // Right after the quote, and with a space before the bracket.
  assert.equal(rqlCompletions("select properties [ '", 21, false, data)?.options.length, 3);
  // Another string is still not completed, nor attributes['.
  assert.equal(rqlCompletions("select attributes['pl", 21, true, data), null);
  // No property: nothing to offer.
  assert.equal(rqlCompletions("select properties['", 19, true), null);
});

test("the editor offers tasks on traces and scores (RTL-397)", () => {
  for (const table of ["traces", "scores"])
    assert.ok((labels(`select | from ${table}`) ?? []).includes("tasks"), table);
  assert.ok(!(labels("select | from events") ?? []).includes("tasks"));
});
