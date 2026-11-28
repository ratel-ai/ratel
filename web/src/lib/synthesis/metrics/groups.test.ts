import assert from "node:assert/strict";
import { test } from "node:test";
import { flowQuery, type Query } from "@/lib/contracts/query";
import { groupQuery } from "@/lib/synthesis/metrics/group-query";
import { GROUP_QUERIES_PER_PROJECT, runGrouped } from "@/lib/synthesis/metrics/groups";
import type { QueryResult } from "@/lib/synthesis/metrics/query";

const A = "11111111-1111-4111-8111-111111111111";
const B = "77777777-7777-4777-8777-777777777777";
const VALUES = {
  values: Array.from({ length: 12 }, (_, index) => ({ value: `v${index}`, traces: 12 - index })),
  distinct: 12,
};
const FLOW = { kind: "flow" } as unknown as QueryResult;

test("a widget with a group-by never runs more small queries of a project at a time than the limit", async () => {
  const running = new Map<string, number>();
  const most = new Map<string, number>();
  const run = (projectId: string) => async () => {
    const now = (running.get(projectId) ?? 0) + 1;
    running.set(projectId, now);
    most.set(projectId, Math.max(most.get(projectId) ?? 0, now));
    await new Promise((resolve) => setTimeout(resolve, 5));
    running.set(projectId, (running.get(projectId) ?? 1) - 1);
    return FLOW;
  };
  const query = flowQuery("tool", { groupBy: "user", groupLimit: 12 });
  // Three widgets of one project and one of another, all at once, as a dashboard reads them.
  const results = await Promise.all(
    [A, A, A, B].map((projectId) =>
      runGrouped(projectId, query, { values: async () => VALUES, run: run(projectId) }),
    ),
  );
  assert.equal(GROUP_QUERIES_PER_PROJECT, 2);
  assert.equal(most.get(A), GROUP_QUERIES_PER_PROJECT);
  assert.equal(most.get(B), GROUP_QUERIES_PER_PROJECT);
  for (const result of results) assert.equal(result.groups.length, 12);
});

test("the values drawn are the limit's, the rest are counted, and a failed one is null", async () => {
  const query = flowQuery("tool", { groupBy: { property: "plan" } });
  const result = await runGrouped(A, query, {
    values: async () => VALUES,
    run: async (small) => {
      if (JSON.stringify(small).includes('"v1"')) throw new Error("timeout");
      return FLOW;
    },
  });
  assert.deepEqual(
    result.groups.map(({ value, traces }) => `${value} ${traces}`),
    ["v0 12", "v1 11", "v2 10", "v3 9", "v4 8", "v5 7"],
  );
  assert.equal(result.groups[1].result, null);
  assert.equal(result.leftOut, 6);
  assert.deepEqual(result.by, { property: "plan" });
});

test("a value's query is the query with one more clause, and no group-by", () => {
  const query = flowQuery("tool", {
    filters: { users: ["u1", "u2"] },
    groupBy: "user",
    groupLimit: 3,
  });
  const filtersOf = (small: Query) => (small as { filters?: unknown }).filters;
  assert.deepEqual(
    groupQuery(query, "u1"),
    flowQuery("tool", { filters: { users: ["u1", "u2"], and: [{ users: ["u1"] }] } }),
  );
  assert.deepEqual(filtersOf(groupQuery(query, null)), {
    users: ["u1", "u2"],
    and: [{ without: ["user"] }],
  });
  const byPlan = flowQuery("tool", { groupBy: { property: "plan" } });
  assert.deepEqual(filtersOf(groupQuery(byPlan, "pro")), {
    and: [{ properties: { plan: ["pro"] } }],
  });
  assert.deepEqual(filtersOf(groupQuery(byPlan, null)), { and: [{ withoutProperties: ["plan"] }] });
});
