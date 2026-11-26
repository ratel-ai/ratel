import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, type RqlPageFilter } from "../compile";

/**
 * The page filter in the compiled SQL: each part on each of the five tables. On `traces` it is a
 * condition on the table's own columns; on the others it keeps the rows whose trace matches, so
 * every part applies on every table. Each value is a bound parameter.
 */

const NOW = new Date("2026-11-25T12:00:00.000Z");
const TABLES = ["events", "traces", "scores", "sessions", "users"] as const;

/** Each part, with the condition on `rql.traces` and the parameters after the window bounds. */
const PARTS: [string, RqlPageFilter, string, unknown[]][] = [
  [
    "models",
    { models: ["gpt-4o", " a'b "] },
    `($3::text = any("models") or $4::text = any("models"))`,
    ["gpt-4o", "a'b"],
  ],
  ["tools", { tools: ["search"] }, `($3::text = any("tools"))`, ["search"]],
  [
    "services",
    { services: ["api", "worker"] },
    `"service_name" in ($3::text, $4::text)`,
    ["api", "worker"],
  ],
  ["environments", { environments: ["prod"] }, `"environment" in ($3::text)`, ["prod"]],
  ["agents", { agents: ["planner"] }, `($3::text = any("agents"))`, ["planner"]],
  ["mcpServers", { mcpServers: ["orders"] }, `($3::text = any("mcp_servers"))`, ["orders"]],
  ["status failed", { status: "failed" }, `"has_error"`, []],
  ["status ok", { status: "ok" }, `not "has_error"`, []],
  ["minCostUsd", { minCostUsd: 0.5 }, `"cost_usd" >= $3::double precision`, [0.5]],
  [
    "minTokens",
    { minTokens: 100 },
    `"input_tokens" + "output_tokens" >= $3::double precision`,
    [100],
  ],
  [
    "and clauses",
    { environments: ["prod"], and: [{ environments: ["dev"] }] },
    `"environment" in ($3::text) and "environment" in ($4::text)`,
    ["prod", "dev"],
  ],
];

for (const table of TABLES)
  for (const [part, filter, condition, values] of PARTS)
    test(`page filter ${part} on ${table}`, () => {
      const result = compileRql(`select count(*) from ${table}`, { now: NOW, filter });
      assert.ok(result.ok, JSON.stringify(result));
      const applied =
        table === "traces"
          ? condition
          : `"trace_id" in (select "trace_id" from "rql"."traces" where ${condition})`;
      assert.ok(result.sql.includes(`< $2::timestamptz and ${applied}`), result.sql);
      assert.deepEqual(result.params.slice(2, 2 + values.length), values);
      if (table === "sessions" || table === "users")
        // Inside the totals, before the trace rows are grouped.
        assert.match(result.sql, new RegExp(`${escaped(applied)} group by`));
    });

test("an empty filter, or one of blanks and zeros, adds nothing", () => {
  const plain = compileRql("select count(*) from traces", { now: NOW });
  assert.ok(plain.ok);
  for (const filter of [{}, { models: [" "], minCostUsd: 0, minTokens: -1, and: [{}] }]) {
    const result = compileRql("select count(*) from traces", { now: NOW, filter });
    assert.ok(result.ok);
    assert.equal(result.sql, plain.sql);
  }
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
