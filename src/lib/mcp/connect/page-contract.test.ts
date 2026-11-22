import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleOperations } from "@/lib/mcp/operations";
import { MCP_CAPABILITY_GROUPS, MCP_EXAMPLE_STEPS } from "./snippets";

/**
 * The connect page names real tools in its copy. Prose drifts; these tests make
 * the build fail when the page starts describing something that no longer
 * exists, rather than quietly misleading a reader into a call that errors.
 */
const operations = new Map(assembleOperations().map((op) => [op.id, op]));

test("every tool named in a capability group actually exists", () => {
  for (const group of MCP_CAPABILITY_GROUPS) {
    for (const example of group.examples) {
      assert.ok(
        operations.has(example),
        `the page advertises "${example}", which is not a real tool`,
      );
    }
  }
});

test("the Changes group only advertises tools that mutate", () => {
  const changes = MCP_CAPABILITY_GROUPS.find((group) => group.title === "Changes");
  assert.ok(changes);

  for (const example of changes.examples) {
    assert.equal(
      operations.get(example)?.mutates,
      true,
      `${example} is listed under Changes but does not mutate`,
    );
  }
});

test("read-only groups never advertise a mutating tool", () => {
  for (const group of MCP_CAPABILITY_GROUPS) {
    if (group.title === "Changes") continue;
    for (const example of group.examples) {
      assert.equal(
        operations.get(example)?.mutates,
        false,
        `${example} mutates and must not sit under "${group.title}"`,
      );
    }
  }
});

test("the worked example only calls tools that exist", () => {
  assert.ok(MCP_EXAMPLE_STEPS.length >= 2, "one call does not show a workflow");

  for (const step of MCP_EXAMPLE_STEPS) {
    assert.ok(
      operations.has(step.tool),
      `the example calls "${step.tool}", which is not a real tool`,
    );
    assert.equal(
      operations.get(step.tool)?.mutates,
      false,
      `${step.tool} mutates; an illustrative example must not suggest a write`,
    );
  }
});

test("every example row matches its declared columns", () => {
  for (const step of MCP_EXAMPLE_STEPS) {
    assert.ok(step.rows.length > 0, `${step.tool} shows no result`);
    if (!step.columns) continue;
    for (const row of step.rows) {
      assert.equal(
        row.length,
        step.columns.length,
        `${step.tool} has a row that does not fit its ${step.columns.length} columns`,
      );
    }
  }
});

test("the capability groups cover every domain a tool belongs to", () => {
  const advertised = new Set(
    MCP_CAPABILITY_GROUPS.flatMap((group) => group.examples).map(
      (id) => operations.get(id)?.domain,
    ),
  );
  const domains = new Set([...operations.values()].map((op) => op.domain));

  for (const domain of domains) {
    assert.ok(
      advertised.has(domain),
      `no capability group shows a tool from the "${domain}" domain, so it is invisible on the page`,
    );
  }
});
