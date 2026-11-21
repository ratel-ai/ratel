import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDimensionFiltersOf } from "./agent-dimensions";
import { filterChips, hasFilters, withoutFilters } from "./v2/filters";
import { resolveOperationsView, resolveSpanListView } from "./view";

/** AOBS-5: the coding-agent dimensions in the Spans URL, its chips and its group-by. */

test("a page reads server, command, skill and agent as exact filters, trimmed", () => {
  assert.deepEqual(
    agentDimensionFiltersOf({
      server: " beluga_board ",
      command: "git",
      skill: ["pr-review", "x"],
      agent: "Explore",
      tool: "Bash",
    }),
    {
      server: "beluga_board",
      command: "git",
      skill: "pr-review",
      agent: "Explore",
    },
  );
  assert.deepEqual(agentDimensionFiltersOf({ agent: "  " }), {});
});

test("the shared resolvers do not read them: only the flagged Spans page adds them", () => {
  const list = resolveSpanListView({ agent: "Explore" });
  assert.equal("agent" in list.queryOptions, false);
  assert.equal(
    "agent" in resolveOperationsView({ groupBy: "command", agent: "Explore" }).queryOptions,
    false,
  );
});

test("the grouped view takes the new groupings", () => {
  for (const groupBy of ["server", "command", "skill", "agent"] as const) {
    assert.equal(resolveOperationsView({ groupBy }).queryOptions.groupBy, groupBy);
  }
  assert.equal(resolveOperationsView({ groupBy: "nonsense" }).queryOptions.groupBy, "name");
});

test("each dimension filter shows as a chip on Spans, and clears with the filters", () => {
  const search = "?server=beluga_board&command=git&skill=pr-review&agent=Explore";
  assert.deepEqual(
    filterChips("spans", search).map((chip) => `${chip.field} ${chip.value}`),
    ["MCP server is beluga_board", "Command is git", "Skill is pr-review", "Agent is Explore"],
  );
  assert.equal(hasFilters("spans", "?agent=Explore"), true);
  assert.equal(withoutFilters("spans", `${search}&range=7d`), "?range=7d");
  // The run list does not filter by them.
  assert.deepEqual(filterChips("runs", search), []);
});
