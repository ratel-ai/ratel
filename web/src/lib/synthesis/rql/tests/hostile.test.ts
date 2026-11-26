import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql } from "../compile";

const NOW = new Date("2026-11-25T12:00:00.000Z");

/** The words the compiler prints. Anything else in the SQL came from somewhere else. */
const COMPILER_WORDS = new Set(
  (
    "select distinct as from where and or not group by having order asc desc nulls first last limit " +
    "is null true false between in like ilike count sum avg min max percentile_cont within date_bin " +
    "timestamptz array filter double precision"
  ).split(" "),
);

/**
 * The SQL less every token the compiler prints: catalog names in double quotes, typed
 * placeholders, the bucket origin, its words and its punctuation. A query whose text reached the
 * SQL leaves a residue.
 */
function residue(sql: string): string {
  return sql
    .replace("timestamptz '2000-01-01 00:00:00+00'", " ")
    .replace(/"[a-z_][a-z0-9_]*"/g, " ")
    .replace(/\$\d+::(?:text|bigint|double precision|boolean|timestamptz|interval)/g, " ")
    .replace(/\b0\.(?:5|9|95|99)\b/g, " ")
    .replace(/[a-z_]+/g, (word) => (COMPILER_WORDS.has(word) ? " " : word))
    .replace(/[(),.*=<>+\-/@[\]:]/g, " ")
    .trim();
}

/**
 * The library lexer reads `--`, `'`, a backslash, a nested `/*` and a non-ASCII character in a
 * block comment unlike Postgres. Postgres never reads the query text, so that changes no safety.
 * The test keeps them out of the block comment, and keeps them in the literals.
 */
const blockComment = (value: string) => value.replace(/\/\*|\*\/|--|'|\\|[^\x20-\x7e]/g, "");

const HOSTILE = [
  "x'; drop table otel_spans; --",
  "'; select pg_sleep(10); --",
  "$$; delete from trace_scores; $$",
  "/* comment */ ' or 1=1 --",
  "\\'; reset role; --",
  'a" or "1"="1',
  "\u202e; grant all on rql.events to public",
  "x' || (select current_setting('rql.project_id')) || '",
];

test("hostile literals are parameters, and no text of the query reaches the SQL", () => {
  for (const value of HOSTILE) {
    const literal = `'${value.replaceAll("'", "''")}'`;
    const text = `select name, attributes[${literal}] as a /* ${blockComment(value)} */ from events -- ${value.replaceAll("\n", "")}
      where name = ${literal} or model like ${literal} or model in (${literal}, 'b') or attributes[${literal}] = ${literal}
      order by a desc limit 10`;
    const result = compileRql(text, { now: NOW });
    if (!result.ok) assert.fail(`${value}: ${result.error.code} ${result.error.message}`);
    assert.equal(residue(result.sql), "", `${value}\n${result.sql}`);
    assert.ok(result.params.includes(value), value);
    assert.ok(!result.sql.includes(value));
    assert.ok(
      !result.sql.includes("--") && !result.sql.includes("/*") && !result.sql.includes(";"),
    );
  }
});

test("each query the docs give compiles to SQL with no residue", () => {
  const queries = [
    "select time_bucket('1 hour', started_at) as hour, p95(duration_ms), count(*) from traces where contains(models, 'gpt-4o') group by hour order by hour",
    "select scorer, avg(value), count_distinct(trace_id) from scores where passed is false group by scorer having count(*) > 3",
    "select session_id, cost_usd from sessions where trace_count between 2 and 50 order by cost_usd desc nulls last limit 20",
    "select user_id, percentile(total_duration_ms, 0.5) from users group by user_id",
    "select -input_tokens, not has_error, started_at from traces where started_at >= '2026-11-25T00:00:00Z'",
  ];
  for (const text of queries) {
    const result = compileRql(text, { now: NOW });
    if (!result.ok) assert.fail(`${text}: ${result.error.message}`);
    assert.equal(residue(result.sql), "", result.sql);
  }
});

test("a quoted identifier is a name to check, never text for the SQL", () => {
  const result = compileRql('select "name; drop table x" from events', { now: NOW });
  assert.ok(!result.ok && result.error.code === "unknown_column");
  const unknownTable = compileRql('select name from "events; drop table x"', { now: NOW });
  assert.ok(!unknownTable.ok && unknownTable.error.code === "unknown_table");
});

test("an alias is a name of the result, never text for the SQL", () => {
  const result = compileRql('select name as "x"" from pg_shadow --" from events', { now: NOW });
  assert.ok(result.ok);
  assert.equal(residue(result.sql), "");
  assert.equal(result.columns.length, 1);
});
