import assert from "node:assert/strict";
import { test } from "node:test";
import { FAMILY_KEYWORDS, INTERNAL_PRODUCT_NAMES, ROUTING_KEYWORDS } from "@/lib/mcp/naming";
import { assembleOperations } from "@/lib/mcp/operations";

/**
 * Naming, enforced rather than remembered.
 *
 * A one-off naming pass rots by the third pull request after it. These rules
 * exist because a flat MCP surface has no discovery step in front of it: the
 * name, description and keywords are the whole routing table, and a tool that
 * competes with another for the same question makes an agent choose blind.
 *
 * Read `lib/mcp/naming.ts` before adding a tool. Failing here means the surface
 * got harder to navigate, not that the test is fussy.
 */
const operations = assembleOperations();
const byId = new Map(operations.map((operation) => [operation.id, operation]));

const claims = new Map<string, string[]>();
for (const operation of operations) {
  for (const keyword of operation.keywords ?? []) {
    claims.set(keyword, [...(claims.get(keyword) ?? []), operation.id]);
  }
}

test("every question in the routing table has exactly one owner, and it exists", () => {
  for (const [keyword, owner] of Object.entries(ROUTING_KEYWORDS)) {
    assert.ok(byId.has(owner), `${keyword} is owned by ${owner}, which is not a tool`);

    const claimants = claims.get(keyword) ?? [];
    assert.deepEqual(
      claimants,
      [owner],
      `"${keyword}" must be claimed by ${owner} alone, but is claimed by ${claimants.join(", ") || "nobody"}`,
    );
  }
});

/**
 * The failure this whole pass exists to prevent. Before it, "cost" was claimed
 * by three tools and "tokens" by four, two of which read pipelines that can
 * legitimately disagree. An agent asked what a week cost had no basis to choose
 * and so chose arbitrarily, and the answer it gave was sometimes one the
 * customer's own dashboard contradicts.
 */
test("no tool claims a question another tool owns", () => {
  for (const operation of operations) {
    for (const keyword of operation.keywords ?? []) {
      const owner = ROUTING_KEYWORDS[keyword];
      if (!owner) continue;
      assert.equal(
        operation.id,
        owner,
        `${operation.id} claims "${keyword}", which belongs to ${owner}. Name ${owner} in the description instead.`,
      );
    }
  }
});

/**
 * Subjects may be shared inside a family: an agent that types "skill" has
 * already narrowed to a noun and will pick by verb. Anything else shared three
 * ways is a collision, and the fix is a better keyword rather than a longer
 * allowlist, which is why the allowlist is a decision someone has to make.
 */
test("a keyword shared three ways is a subject, not an accident", () => {
  const families = new Set(FAMILY_KEYWORDS);
  for (const [keyword, claimants] of claims) {
    if (claimants.length < 3) continue;
    assert.ok(
      families.has(keyword),
      `"${keyword}" is claimed by ${claimants.join(", ")}. Give the question to one of them, or add it to FAMILY_KEYWORDS if it genuinely names a subject.`,
    );
  }
});

test("tool ids never require knowing what we call a screen", () => {
  for (const operation of operations) {
    for (const name of INTERNAL_PRODUCT_NAMES) {
      assert.ok(
        !operation.id.includes(name),
        `${operation.id} contains "${name}", which is a Ratel screen. A customer's agent has read our tool list and nothing else. Keep the product name as a keyword instead.`,
      );
    }
  }
});

/**
 * Words that name a whole category rather than a question. Each of these was
 * claimed by three or more tools before this pass, and none of them ever routed
 * anywhere: "usage" meant plan usage, tool usage and token usage; "detail"
 * meant three different entities.
 */
const TOO_VAGUE = [
  "usage",
  "detail",
  "missing",
  "metrics",
  "aggregate",
  "data",
  "queries",
  "tools",
  "status",
  "info",
  "summary",
];

test("no keyword is a whole category standing in for a question", () => {
  for (const operation of operations) {
    for (const keyword of operation.keywords ?? []) {
      assert.ok(
        !TOO_VAGUE.includes(keyword),
        `${operation.id} claims "${keyword}", which names a category rather than a question. Qualify it ("cost per tool", "traces not arriving").`,
      );
    }
  }
});

/**
 * Where two tools are genuinely close, each has to hand the reader off to the
 * other. The name can only carry so much: `get_span_totals` and
 * `list_span_groups` are the same filter over the same source, and only the
 * descriptions can say that one returns a row and the other returns rows.
 */
const MUST_CROSS_REFERENCE: ReadonlyArray<[string, string]> = [
  ["get_trace_health", "get_cost_by_day"],
  ["get_cost_by_day", "span"],
  ["get_span_totals", "get_trace_health"],
  ["list_span_groups", "get_cost_by_tool"],
  ["get_cost_by_tool", "list_span_groups"],
  ["list_declared_tools", "list_invoked_tools"],
  ["list_invoked_tools", "list_declared_tools"],
  ["list_calibration_mismatches", "test_retrieval"],
  ["test_retrieval", "update_skill"],
  ["list_insights", "get_improvement_signals"],
  ["list_insights", "get_fix"],
  ["get_fix", "run_eval"],
  ["run_eval", "mark_fix_shipped"],
  ["create_experiment", "ratel.experiment.id"],
];

test("close neighbours name each other, so a near miss is one hop from right", () => {
  for (const [id, expected] of MUST_CROSS_REFERENCE) {
    const operation = byId.get(id);
    assert.ok(operation, `${id} should exist`);
    assert.ok(
      operation.description.includes(expected),
      `${id} should point at ${expected}: they answer questions an agent will confuse.`,
    );
  }
});

test("every keyword is lowercase, so matching never turns on capitalisation", () => {
  for (const operation of operations) {
    for (const keyword of operation.keywords ?? []) {
      assert.equal(keyword, keyword.toLowerCase(), `${operation.id}: "${keyword}"`);
    }
  }
});
