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
const operations = assembleOperations({ focusedConsole: true, sandboxes: true });

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

/** A feature domain keeps its reads and writes together; each write still declares `mutates`. */
const FEATURE_DOMAINS = new Set(["sandboxes", "evals"]);

test("write operations are exactly those declaring mutates", () => {
  const mutating = operations
    .filter((operation) => operation.mutates && !FEATURE_DOMAINS.has(operation.domain))
    .map((o) => o.id);
  const inWritesDomain = operations
    .filter((operation) => operation.domain === "writes")
    .map((o) => o.id);

  assert.deepEqual(
    mutating.sort(),
    inWritesDomain.sort(),
    "an operation that mutates must live in the writes domain or a feature domain, and every writes-domain operation mutates",
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
  ["get_overview", false],
  ["list_overview_changes", false],
  ["change_overview_layout", true],
  ["undo_overview_change", true],
  ["restore_overview_layout", true],
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
  // UI parity (RC-234): every console page a customer uses has a tool. Reads
  // first, then the writes, each reusing the console's own lib function.
  ["list_runtime_catalog", false],
  ["get_run_summary", false],
  ["get_span", false],
  ["get_trace_conversation", false],
  ["list_spans", false],
  ["list_logs", false],
  ["compare_traces", false],
  ["get_trace_ranking", false],
  ["get_turn", false],
  ["get_run_stats", false],
  ["get_agent_health", false],
  ["list_issue_examples", false],
  ["get_self_corrections", false],
  ["list_intents", false],
  ["get_intent", false],
  ["get_experiment", false],
  ["get_selection", false],
  ["get_quality", false],
  ["list_description_rewrites", false],
  ["list_ranking_graphs", false],
  ["get_ranking_graph", false],
  ["list_sdk_events", false],
  ["get_sdk_event", false],
  ["list_api_keys", false],
  ["get_sdk_setup", false],
  ["list_shipments", false],
  ["get_lineage", false],
  ["get_analysis_freshness", false],
  ["get_session", false],
  ["get_session_step_content", false],
  // The MCP servers page (RC-777).
  ["list_mcp_servers", false],
  ["get_mcp_server", false],
  // The Agents page (RC-775).
  ["list_agents", false],
  ["get_agent", false],
  // Writes the console offers: hide a slow signal, ask for a reading, review a
  // description rewrite, start a metered quality analysis.
  ["set_health_signal_hidden", true],
  ["request_analysis", true],
  ["review_description_rewrite", true],
  ["run_quality_analysis", true],
  // The improvement loop (RC-43). run_eval mutates: the
  // eval gate (RC-46) records each simulation it runs.
  ["list_tasks", false],
  ["get_task", false],
  ["list_insights", false],
  ["list_fixes", false],
  ["get_fix", false],
  ["get_eval", false],
  ["run_eval", true],
  ["create_experiment", true],
  ["mark_fix_shipped", true],
  // The task and eval-set pages (RC-234).
  ["list_task_simulations", false],
  ["get_fix_eval_set", false],
  ["change_task_scorer", true],
  ["change_task_eval_set", true],
  ["draft_task_test", true],
  ["change_task_simulation", true],
  ["change_fix_eval_set", true],
  ["dismiss_fix", true],
  // Ratel sandbox (decision `mcp-surface`), behind the `sandboxes` flag. sandbox_run starts a VM run.
  ["sandbox_list", false],
  ["sandbox_get_version", false],
  ["sandbox_run", true],
  ["sandbox_get_run", false],
];

test("the operation contract matches the reviewed snapshot", () => {
  const actual = operations.map((operation) => [operation.id, operation.mutates] as const);

  assert.deepEqual(
    [...actual].sort((a, b) => a[0].localeCompare(b[0])),
    [...EXPECTED_CONTRACT].sort((a, b) => a[0].localeCompare(b[0])),
    "Operations changed. Update EXPECTED_CONTRACT, deciding explicitly whether each new operation mutates.",
  );
});
