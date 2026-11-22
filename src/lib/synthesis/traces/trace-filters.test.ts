import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { traceFacetsQuery, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";

/** RC-885: the "pivot is" filter on the rollup's `dims`, and the facet query with and without pivots. */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WINDOW = {
  since: new Date("2026-11-02T08:59:00.000Z"),
  until: new Date("2026-11-02T09:01:00.000Z"),
};
const dialect = new PgDialect();

test("an empty filter has no condition, as before pivots", () => {
  assert.equal(traceFilterCondition(undefined), null);
  assert.equal(traceFilterCondition({}), null);
  assert.equal(traceFilterCondition({ pivots: {} }), null);
  assert.equal(traceFilterCondition({ pivots: { client: [] } }), null);
  assert.equal(traceFilterCondition({ pivots: { client: [" ", ""] } }), null);
});

test("a pivot value is a containment on dims, so the GIN index serves it", () => {
  const query = render(traceFilterCondition({ pivots: { client: ["acme"] } }));
  assert.equal(query.sql, "(s.dims @> $1::jsonb)");
  assert.deepEqual(query.params, ['{"client":"acme"}']);
});

test("values of one pivot are alternatives, pivots combine with AND", () => {
  const query = render(
    traceFilterCondition({ pivots: { client: ["acme", "globex", "acme"], end_user: ["u-1"] } }),
  );
  assert.equal(query.sql, "(s.dims @> $1::jsonb or s.dims @> $2::jsonb) and (s.dims @> $3::jsonb)");
  assert.deepEqual(query.params, [
    '{"client":"acme"}',
    '{"client":"globex"}',
    '{"end_user":"u-1"}',
  ]);
});

test("a key that no pivot can have is ignored", () => {
  assert.equal(traceFilterCondition({ pivots: { "bad key!": ["x"], "": ["y"] } }), null);
  const query = render(
    traceFilterCondition({ pivots: { "bad key!": ["x"], "tenant.id": ["t1"] } }),
  );
  assert.deepEqual(query.params, ['{"tenant.id":"t1"}']);
});

test("the pivot condition joins the other properties", () => {
  const query = render(traceFilterCondition({ models: ["gpt-4o"], pivots: { client: ["acme"] } }));
  assert.match(query.sql, /^s\.models && .* and \(s\.dims @> \$\d::jsonb\)$/);
});

test("without pivots the facet query is the same SQL as on main", () => {
  // sha256 of the rendered SQL and params on main (e5677797), before RC-885.
  assert.equal(facetHash({}), "2fceaaca71635a4f6d1a73d795822004bac8883021fc7267eb92f8d49d6927ca");
  assert.equal(
    facetHash({ pivots: [] }),
    "2fceaaca71635a4f6d1a73d795822004bac8883021fc7267eb92f8d49d6927ca",
  );
  // Owned (ADR-0030): with the entity facets this tree also reads the harnesses and countries
  // (RP-138), so its hash before RC-885 is this tree's, not upstream's.
  assert.equal(
    facetHash({ entities: true }),
    "5cea576999cc9b18e8adb2bfa9c851de9b5964de1a4640e860bc154e9d9b410d",
  );
});

test("with pivots the facet query also counts each pivot's values from dims", () => {
  const query = dialect.sqlToQuery(
    traceFacetsQuery(PROJECT_ID, WINDOW, 50, { pivots: ["client", "end_user"] }),
  );
  assert.match(query.sql, /s\.dims/);
  assert.match(query.sql, /'pivot:' \|\| k/);
  assert.ok(
    query.params.includes("client") ||
      query.params.some((param) => String(param).includes("client")),
  );
});

function render(condition: SQL | null): { sql: string; params: unknown[] } {
  assert.ok(condition, "expected a condition");
  return dialect.sqlToQuery(condition);
}

function facetHash(options: Parameters<typeof traceFacetsQuery>[3]): string {
  const query = dialect.sqlToQuery(traceFacetsQuery(PROJECT_ID, WINDOW, 50, options));
  return createHash("sha256")
    .update(query.sql + JSON.stringify(query.params))
    .digest("hex");
}
