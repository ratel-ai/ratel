import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, describeRqlSchema, RQL_LIMITS } from "../compile";
import { RQL_FUNCTIONS, RQL_TABLES } from "../domain/catalog";

const NOW = new Date("2026-11-25T12:00:00.000Z");

test("the description has the language version, the six tables and the limits", () => {
  const schema = describeRqlSchema();
  assert.equal(schema.language, "rql");
  assert.equal(schema.version, 1);
  assert.deepEqual(
    schema.tables.map((table) => table.name),
    ["events", "traces", "scores", "sessions", "users", "prompts"],
  );
  assert.deepEqual(schema.limits, { ...RQL_LIMITS });
});

test("each table lists the catalog columns with their types and descriptions", () => {
  const schema = describeRqlSchema();
  for (const table of RQL_TABLES) {
    const described = schema.tables.find((entry) => entry.name === table.name);
    assert.ok(described);
    assert.equal(described.timeColumn, table.grain === "rows" ? table.timeColumn : undefined);
    assert.deepEqual(
      described.columns,
      table.columns.map(({ name, type, description }) => ({ name, type, description })),
    );
    assert.ok(described.description.length > 0);
  }
  const events = schema.tables.find((table) => table.name === "events");
  assert.ok(
    events?.columns.some(
      (column) =>
        column.name === "type" &&
        ["llm_call", "tool_call", "search", "agent_run", "other"].every((value) =>
          column.description.includes(`'${value}'`),
        ),
    ),
  );
  for (const table of ["events", "traces", "scores", "sessions", "users"]) {
    const names = schema.tables.find((entry) => entry.name === table)?.columns.map((c) => c.name);
    assert.ok(names?.includes("user_id"), table);
    assert.ok(!names?.includes("end_user_id"), table);
  }
});

test("the description lists every function and the operators", () => {
  const schema = describeRqlSchema();
  assert.deepEqual(
    schema.functions.map((fn) => fn.name),
    RQL_FUNCTIONS.map((fn) => fn.name),
  );
  for (const fn of schema.functions) {
    assert.ok(fn.signature && fn.returns && fn.description && fn.example, fn.name);
  }
  assert.ok(schema.operators.includes("LIKE"));
  assert.ok(schema.rules.some((rule) => /window/.test(rule)));
});

test("each example of the description and of its functions compiles", () => {
  const schema = describeRqlSchema();
  assert.ok(schema.examples.length >= 5);
  for (const query of [
    ...schema.examples.map((example) => example.rql),
    ...schema.functions.map((fn) => fn.example),
  ]) {
    const result = compileRql(query, { now: NOW });
    assert.ok(result.ok, `${query}: ${result.ok ? "" : result.error.message}`);
  }
});

test("the description is the same value on each call, and is plain JSON", () => {
  const schema = describeRqlSchema();
  assert.deepEqual(describeRqlSchema(), schema);
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
});
