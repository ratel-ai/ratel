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

test("the columns are those of the table in FROM, then the functions", () => {
  const options = labels("select | from scores") ?? [];
  const scores = RQL_TABLES.find((t) => t.name === "scores");
  assert.ok(scores);
  for (const column of scores.columns) assert.ok(options.includes(column.name), column.name);
  assert.ok(
    !options.includes("duration_ms") || scores.columns.some((c) => c.name === "duration_ms"),
  );
  for (const word of ["count", "rate", "each"]) assert.ok(options.includes(word), word);
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
  // Without asking, right after a closing parenthesis: no list until a space or a word.
  assert.equal(rqlCompletions("select count(*)", 15, false), null);
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

const types = (text: string) => [...new Set(at(text)?.options.map((option) => option.type))];
const TRACES = RQL_TABLES.find((t) => t.name === "traces")?.columns.map((c) => c.name) ?? [];
const FUNCTIONS = RQL_FUNCTIONS.map((fn) => fn.name);

test("where an operand is expected the editor offers the columns, then the functions, no operator", () => {
  for (const text of [
    "select count(*) from traces where |",
    "select count(*) from traces where has_error and |",
    "select count(*) from traces where has_error or |",
    "select count(*) from traces where not |",
    "select count(*) from traces where duration_ms > |",
    "select count(*) from traces where duration_ms + |",
    "select count(*) from traces where (|",
    "select count(|) from traces",
    "select service_name, count(*) from traces group by |",
    "select service_name, count(*) from traces group by service_name, |",
    "select service_name, count(*) from traces group by service_name having |",
    "select service_name from traces order by |",
    "select service_name from traces order by service_name, |",
    "select count(*) from traces on |",
  ])
    assert.deepEqual(labels(text), [...TRACES, ...FUNCTIONS], text);
  // Typing a word keeps the place: the list starts at the word.
  assert.deepEqual(labels("select count(*) from traces where dur|"), [...TRACES, ...FUNCTIONS]);
  assert.equal(at("select count(*) from traces where dur|")?.from, 34);
});

test("in a select list the editor also offers *, and no operator", () => {
  assert.deepEqual(labels("select | from traces"), ["*", "distinct", ...TRACES, ...FUNCTIONS]);
  assert.deepEqual(labels("select distinct | from traces"), ["*", ...TRACES, ...FUNCTIONS]);
  assert.deepEqual(labels("select service_name, | from traces"), ["*", ...TRACES, ...FUNCTIONS]);
  // A comma between the arguments of a function is not a select item.
  assert.deepEqual(labels("select coalesce(cost_usd, |) from traces"), [...TRACES, ...FUNCTIONS]);
  assert.deepEqual(types("select | from traces"), ["keyword", "property", "function"]);
  assert.ok(compileRql("select * from traces", { now: NOW }).ok);
});

test("before there is a table in FROM the editor offers the columns of every table, each once, with its tables", () => {
  const options = at("select |")?.options ?? [];
  const columns = options.filter((option) => option.type === "property");
  assert.deepEqual(
    columns.map((column) => column.label),
    [...new Set(RQL_TABLES.flatMap((table) => table.columns.map((c) => c.name)))],
  );
  for (const column of columns) {
    const tables = RQL_TABLES.filter((t) => t.columns.some((c) => c.name === column.label));
    assert.ok(column.detail?.endsWith(` · ${tables.map((t) => t.name).join(", ")}`), column.label);
  }
  assert.match(columns.find((c) => c.label === "scorer")?.detail ?? "", /^text · scores$/);
  assert.deepEqual(types("select |"), ["keyword", "property", "function"]);
  assert.deepEqual(types("select count(*) where |"), ["property", "function"]);
});

test("after a whole operand the editor offers the keywords that can follow, then the operators", () => {
  const operators = describeRqlSchema().operators.map((operator) => operator.toLowerCase());
  const symbols = ["=", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "<>"];
  const between = ["and", "or", "like", "ilike", "in", "between"];
  const follows = (text: string, words: string[]) => {
    const found = labels(text) ?? [];
    assert.deepEqual(found.slice(0, words.length), words, text);
    const rest = found.slice(words.length);
    assert.deepEqual(rest.slice(0, between.length), between, text);
    for (const symbol of symbols) assert.ok(rest.includes(symbol), `${text} ${symbol}`);
    // Every operator is one of the schema description; no column, no function.
    for (const label of rest) assert.ok(operators.includes(label), `${text} ${label}`);
  };
  follows("select service_name | from traces", ["as", "from"]);
  follows("select count(*) |", ["as", "from"]);
  follows("select count(*) from traces where has_error |", ["group by", "order by", "limit"]);
  follows("select count(*) from traces where service_name = 'a' |", [
    "group by",
    "order by",
    "limit",
  ]);
  follows("select count(*) from traces where (duration_ms > 5) |", [
    "group by",
    "order by",
    "limit",
  ]);
  follows("select service_name from traces group by service_name |", [
    "having",
    "order by",
    "limit",
  ]);
  follows("select service_name from traces group by 1 having count(*) > 1 |", [
    "order by",
    "limit",
  ]);
  follows("select service_name from traces order by service_name |", [
    "asc",
    "desc",
    "nulls first",
    "nulls last",
    "limit",
  ]);
  // Inside parentheses no clause can start.
  follows("select count(*) from traces where (has_error |", []);
  // A word being typed keeps the place.
  assert.deepEqual(labels("select service_name fr|")?.slice(0, 2), ["as", "from"]);
});

test("where no operator fits the editor offers the keywords that can follow only", () => {
  assert.deepEqual(labels("|"), ["select"]);
  assert.deepEqual(labels("select * |"), ["from"]);
  assert.deepEqual(labels("select count(*) as n |"), ["from"]);
  assert.deepEqual(labels("select count(*) from traces |"), [
    "where",
    "group by",
    "order by",
    "limit",
  ]);
  assert.deepEqual(labels("select service_name from traces order by service_name desc |"), [
    "nulls first",
    "nulls last",
    "limit",
  ]);
  assert.deepEqual(labels("select count(*) from traces where session_id is |"), [
    "not",
    "null",
    "true",
    "false",
  ]);
  assert.deepEqual(labels("select count(*) from traces where session_id is not |"), [
    "null",
    "true",
    "false",
  ]);
  // The second word of GROUP BY: the list starts at the first.
  const by = at("select count(*) from traces group b|");
  assert.deepEqual([by?.from, by?.options.map((o) => o.label)], [28, ["group by"]]);
  const nulls = at("select service_name from traces order by service_name nulls |");
  assert.deepEqual(
    [nulls?.from, nulls?.options.map((o) => o.label)],
    [54, ["nulls first", "nulls last"]],
  );
  // An alias, a row count and an attribute key are the person's own: nothing to offer.
  for (const text of [
    "select count(*) as |",
    "select count(*) from traces limit |",
    "select count(*) from traces limit 5 |",
    "select attributes[|",
  ])
    assert.equal(at(text), null, text);
});

test("a list the person asked for with no word typed follows the same places", () => {
  const explicit = (text: string) =>
    rqlCompletions(text, text.length, true)?.options.map((option) => option.type);
  assert.deepEqual([...new Set(explicit("select "))], ["keyword", "property", "function"]);
  assert.deepEqual(
    [...new Set(explicit("select count(*) from traces where "))],
    ["property", "function"],
  );
  assert.deepEqual([...new Set(explicit("select count(*) from "))], ["class"]);
  assert.deepEqual(
    [...new Set(explicit("select count(*) from traces where has_error "))],
    ["keyword", "operator"],
  );
});

test("the list opens by itself where a table, an operand or a keyword is expected", () => {
  const opens = (text: string) =>
    rqlCompletions(text, text.length, false)?.options.map((option) => option.label) ?? null;
  const operand = (text: string) => assert.ok(opens(text)?.includes("duration_ms"), text);
  operand("select ");
  operand("select count(*) from traces where ");
  operand("select service_name,");
  operand("select service_name, ");
  operand("select count(*) from traces where duration_ms >");
  operand("select count(*) from traces where duration_ms >= ");
  operand("select count(*) from traces where duration_ms !=");
  operand("select count(*) from traces where duration_ms + ");
  operand("select count(");
  operand("select count(*)\nfrom traces\nwhere ");
  assert.deepEqual(
    opens("select count(*) from "),
    RQL_TABLES.map((t) => t.name),
  );
  assert.deepEqual(opens("select count(*) from traces "), [
    "where",
    "group by",
    "order by",
    "limit",
  ]);
  // Not inside a string or a comment, nor after AS, LIMIT or an attribute key.
  for (const text of [
    "select count(*) from traces where service_name = 'a ",
    "select count(*) from traces where service_name = 'a,",
    "select count(*) from traces -- where ",
    "select count(*) from traces -- a, ",
    "select count(*) as ",
    "select count(*) from traces limit ",
    "select attributes[",
  ])
    assert.equal(rqlCompletions(text, text.length, false), null, text);
  // Right after `*` or `)`, a space comes first.
  assert.equal(rqlCompletions("select *", 8, false), null);
  assert.equal(rqlCompletions("select count(*)", 15, false), null);
});

test("a comment and a string do not change the place", () => {
  assert.deepEqual(labels("select count(*) -- from\n from traces where |"), [
    ...TRACES,
    ...FUNCTIONS,
  ]);
  assert.deepEqual(labels("select count(*) from traces where service_name = 'a, b' and |"), [
    ...TRACES,
    ...FUNCTIONS,
  ]);
});
