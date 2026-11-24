import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import { definitionSummary, scoreLabel, searchOfFilter } from "./format";
import { checkDraft } from "./test-support";

test("a stored filter survives the filter bar's query string", () => {
  const filters: TraceFilter[] = [
    {},
    {
      models: ["a b", "c&d"],
      tools: ["search"],
      services: ["web"],
      environments: ["prod"],
      agents: ["main"],
      mcpServers: ["slack"],
      status: "failed",
      minCostUsd: 0.1,
      minTokens: 1000,
    },
  ];
  for (const filter of filters)
    assert.deepEqual(traceFilterFromSearch(searchOfFilter(filter), { entities: true }), filter);
});

test("a scorer and its result in words", () => {
  assert.equal(definitionSummary(checkDraft()), "Duration (ms) is at most 1000");
  assert.equal(
    definitionSummary(checkDraft({ config: { path: "attributes.user.plan", op: "exists" } })),
    "user.plan exists",
  );
  assert.equal(scoreLabel({ passed: true, value: 1 }), "Pass");
  assert.equal(scoreLabel({ passed: false, value: 0 }), "Fail");
  assert.equal(scoreLabel({ passed: null, value: 4 }), "4 of 5");
});
