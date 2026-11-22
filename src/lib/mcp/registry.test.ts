import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildRegistry, type McpOperation } from "./registry";

function operation(id: string): McpOperation {
  return {
    id,
    domain: "catalog",
    title: id,
    description: `does ${id}`,
    scope: "project",
    mutates: false,
    params: z.object({}),
    async execute() {
      return { data: null };
    },
  };
}

test("buildRegistry indexes operations by id", () => {
  const registry = buildRegistry([operation("a"), operation("b")]);

  assert.equal(registry.size, 2);
  assert.equal(registry.get("a")?.id, "a");
});

test("a duplicate id throws rather than silently shadowing", () => {
  assert.throws(
    () => buildRegistry([operation("dup"), operation("dup")]),
    /Duplicate MCP operation id: dup/,
  );
});
