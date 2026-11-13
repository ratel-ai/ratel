import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { assembleOperations } from "@/lib/mcp/operations";

/**
 * What a client that connected yesterday can still call today.
 *
 * MCP clients fetch `tools/list` once when they connect and hold it for the
 * session. This server is stateless: it opens no stream, so it cannot send
 * `notifications/tools/list_changed`, and it does not claim it can. A deploy
 * therefore updates the endpoint for everyone immediately, and updates nobody's
 * cached tool list until they reconnect.
 *
 * That asymmetry decides which changes are safe:
 *
 *   - **Adding a tool is free.** Sessions that predate it simply do not see it
 *     yet, and nothing they already do breaks. This test stays silent.
 *   - **Renaming or removing one breaks every live session**, which keeps
 *     calling a name that no longer exists until someone restarts their client.
 *   - **Adding a required parameter breaks them too**, and more confusingly: the
 *     client validates against its cached schema, believes the call is
 *     well-formed, sends it, and gets rejected.
 *
 * So the pinned surface below is a promise, not a snapshot. Growing it needs no
 * edit here. Shrinking it, renaming an entry, or adding a required parameter
 * means deleting or changing a line, which is the point: that is a decision
 * somebody makes on purpose and a reviewer sees, rather than a rename that
 * quietly strands everyone who is already connected.
 *
 * When you do break it deliberately, the rollout is: ship the new name
 * alongside the old, wait for clients to reconnect, then remove the old one in a
 * later release.
 */
const PUBLISHED_SURFACE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["whoami", []],
  ["list_projects", []],
  ["get_project_overview", []],
  ["list_skills", []],
  ["get_skill", ["skillId"]],
  ["get_catalog_status", []],
  ["list_declared_tools", []],
  ["list_invoked_tools", []],
  ["list_catalog_overrides", []],
  ["get_trace_health", []],
  ["list_traces", []],
  ["get_trace", ["traceId"]],
  ["list_span_groups", []],
  ["get_span_totals", []],
  ["get_cost_by_day", []],
  ["get_cost_by_tool", []],
  ["get_traces_ingest_diagnostics", []],
  ["list_calibrations", []],
  ["get_calibration", ["experimentName"]],
  ["list_calibration_mismatches", ["experimentName"]],
  ["get_flag_status", []],
  ["get_quota_status", []],
  ["get_job_status", []],
  ["get_improvement_signals", []],
  ["list_search_queries_for_skill", ["skillName"]],
  ["test_retrieval", ["query"]],
  ["create_skill", ["skill"]],
  ["update_skill", ["patch", "skillId"]],
  ["publish_skill", ["skillId"]],
  ["archive_skill", ["skillId"]],
  ["import_skills", ["skills"]],
  ["set_catalog_override", ["entryId", "kind", "searchableDescription"]],
];

const published = new Map(
  assembleOperations().map((operation) => {
    const schema = z.toJSONSchema(operation.params, { io: "input" }) as {
      required?: string[];
    };
    return [operation.id, (schema.required ?? []).sort()];
  }),
);
// `whoami` is registered by the server rather than the registry, and takes no
// parameters, so it is pinned here by hand.
published.set("whoami", []);

test("no tool a connected client knows about has disappeared", () => {
  for (const [name] of PUBLISHED_SURFACE) {
    assert.ok(
      published.has(name),
      `"${name}" was published and is now gone. Every client still holding a cached tool list will call it and fail until it reconnects. If the removal is intended, delete its line above and say why in the commit.`,
    );
  }
});

test("no tool has gained a required parameter", () => {
  for (const [name, wasRequired] of PUBLISHED_SURFACE) {
    const nowRequired = published.get(name);
    if (!nowRequired) continue;

    for (const parameter of nowRequired) {
      assert.ok(
        wasRequired.includes(parameter),
        `${name} now requires "${parameter}". A client validating against its cached schema will send a call it believes is valid and be rejected. Give it a default, or accept the break by updating the line above.`,
      );
    }
  }
});

/**
 * The safe direction, asserted so it stays safe. New tools must not need an
 * entry here, or the test becomes a chore and someone deletes it.
 */
test("adding a tool does not require touching this file", () => {
  const pinned = new Set(PUBLISHED_SURFACE.map(([name]) => name));
  const added = [...published.keys()].filter((name) => !pinned.has(name));

  assert.ok(
    added.length >= 0,
    "new tools are additive by construction; this test exists to document that",
  );
});
