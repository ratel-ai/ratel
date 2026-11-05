import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { assembleOperations } from "@/lib/mcp/operations";
import { OPERATION_DOMAINS } from "@/lib/mcp/registry";

/**
 * The contract every operation must satisfy, enforced once rather than
 * remembered per pull request.
 *
 * The pinned snapshot at the bottom is the important part: adding an operation
 * fails this test until its `mutates` value is written down here, which forces
 * the read-or-write decision to be made deliberately and reviewed, instead of
 * slipping in because nobody thought about it.
 */
const operations = assembleOperations();

test("ids are unique, snake_case, and stable-looking", () => {
  const ids = operations.map((operation) => operation.id);

  assert.equal(new Set(ids).size, ids.length, "operation ids must be unique");
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} must be snake_case`);
  }
});

test("every operation is discoverable: title, description, known domain", () => {
  for (const operation of operations) {
    assert.ok(operation.title.length > 0, `${operation.id} needs a title`);
    assert.ok(
      operation.description.length > 20,
      `${operation.id} needs a description an agent can match on`,
    );
    assert.ok(
      operation.description.length <= 400,
      `${operation.id} description is too long for a discovery result`,
    );
    assert.ok(
      OPERATION_DOMAINS.includes(operation.domain),
      `${operation.id} has an unknown domain`,
    );
  }
});

test("project- and organization-scoped operations accept an explicit projectId", () => {
  for (const operation of operations) {
    if (operation.scope === "none") continue;
    const shape = (operation.params as unknown as { shape?: Record<string, unknown> }).shape;
    assert.ok(
      shape && "projectId" in shape,
      `${operation.id} is ${operation.scope}-scoped and must declare projectId (OAuth callers must name the target)`,
    );
  }
});

test("every params schema converts to JSON Schema for discovery", () => {
  for (const operation of operations) {
    assert.doesNotThrow(
      () => z.toJSONSchema(operation.params, { io: "input" }),
      `${operation.id} params cannot be published to search_operations`,
    );
  }
});

test("write operations are exactly those declaring mutates", () => {
  const mutating = operations.filter((operation) => operation.mutates).map((o) => o.id);
  const inWritesDomain = operations
    .filter((operation) => operation.domain === "writes")
    .map((o) => o.id);

  assert.deepEqual(
    mutating.sort(),
    inWritesDomain.sort(),
    "an operation that mutates must live in the writes domain, and vice versa",
  );
});

test("without the loop flag, the loop tools are absent and nothing else changes", () => {
  const withoutLoop = assembleOperations({ includeLoop: false }).map((operation) => operation.id);
  const loop = [
    "list_insights",
    "list_fixes",
    "get_fix",
    "get_eval",
    "run_eval",
    "create_experiment",
    "mark_fix_shipped",
  ];

  for (const id of loop)
    assert.ok(!withoutLoop.includes(id), `${id} must be hidden without FF_MCP_LOOP`);
  assert.deepEqual(
    withoutLoop.sort(),
    operations
      .map((operation) => operation.id)
      .filter((id) => !loop.includes(id))
      .sort(),
  );
});

test("read-only assembly drops every mutating operation", () => {
  const readOnly = assembleOperations({ includeWrites: false });

  assert.equal(
    readOnly.filter((operation) => operation.mutates).length,
    0,
    "includeWrites: false must leave no write operations reachable",
  );
});

/**
 * Adding a row here is the moment to ask: does this operation change anything?
 * If it does it must say so, and live in the writes domain, because that
 * declaration is what tells a client to warn before running it.
 */
const EXPECTED_CONTRACT: ReadonlyArray<[string, boolean]> = [
  ["list_projects", false],
  ["get_project_overview", false],
  ["list_skills", false],
  ["get_skill", false],
  ["get_catalog_status", false],
  ["list_declared_tools", false],
  ["list_invoked_tools", false],
  ["list_catalog_overrides", false],
  ["get_trace_health", false],
  ["list_traces", false],
  ["get_trace", false],
  ["list_span_groups", false],
  ["get_span_totals", false],
  ["get_cost_by_day", false],
  ["get_cost_by_tool", false],
  ["get_traces_ingest_diagnostics", false],
  ["list_calibrations", false],
  ["get_calibration", false],
  ["list_calibration_mismatches", false],
  ["list_tool_cousage", false],
  ["list_tool_transitions", false],
  ["list_intent_tool_usage", false],
  ["list_tool_crafts", false],
  ["get_tool_craft", false],
  ["list_match_quality_runs", false],
  ["get_match_quality_run", false],
  ["get_flag_status", false],
  ["get_quota_status", false],
  ["get_job_status", false],
  ["get_improvement_signals", false],
  ["list_search_queries_for_skill", false],
  ["test_retrieval", false],
  ["create_skill", true],
  ["update_skill", true],
  ["publish_skill", true],
  ["archive_skill", true],
  ["import_skills", true],
  ["set_catalog_override", true],
  ["generate_tool_crafts", true],
  // The improvement loop (RC-43), behind FF_MCP_LOOP. run_eval mutates: the
  // eval gate (RC-46) records each simulation it runs.
  ["list_insights", false],
  ["list_fixes", false],
  ["get_fix", false],
  ["get_eval", false],
  ["run_eval", true],
  ["create_experiment", true],
  ["mark_fix_shipped", true],
];

test("the operation contract matches the reviewed snapshot", () => {
  const actual = operations.map((operation) => [operation.id, operation.mutates] as const);

  assert.deepEqual(
    [...actual].sort((a, b) => a[0].localeCompare(b[0])),
    [...EXPECTED_CONTRACT].sort((a, b) => a[0].localeCompare(b[0])),
    "Operations changed. Update EXPECTED_CONTRACT, deciding explicitly whether each new operation mutates.",
  );
});
