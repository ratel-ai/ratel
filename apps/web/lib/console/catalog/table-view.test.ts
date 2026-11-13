import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildToolsCatalogRows,
  DEFAULT_TOOLS_CATALOG_PAGE_SIZE,
  filterToolsCatalogRows,
  hasObservedUsage,
  nextSortDirection,
  presentProvenances,
  provenanceFilterChoices,
  resolveToolsCatalogView,
  sortToolsCatalogRows,
  toolsCatalogRangeLabel,
  toolsCatalogSearchParams,
} from "@/lib/console/catalog/table-view";
import type { CatalogTool } from "@/lib/synthesis/catalog/tools";
import type { RuntimeCatalogEntry } from "@/lib/synthesis/dashboard";

test("rows are managed only when the runtime ingested a definition", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "managed" }), tool({ name: "observed" }), tool({ name: "unknown" })],
    new Map<string, RuntimeCatalogEntry>([
      ["managed", definition("managed")],
      ["observed", observedEntry("observed")],
    ]),
  );

  assert.deepEqual(
    rows.map((row) => row.provenance),
    ["managed", "observed", "observed"],
  );
  assert.equal(rows[0].definition?.entryId, "managed");
  assert.equal(rows[1].definition, null, "a null entryId is not editable");
  assert.equal(rows[2].definition, null, "a tool with no entry is not editable");
});

test("a stale source marks the row, an inactive one does not", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "quiet", sourceStatus: "stale" }), tool({ name: "live", sourceStatus: "fresh" })],
    new Map(),
  );

  assert.equal(rows[0].stale, true);
  assert.equal(rows[1].stale, false);
});

test("an abandoned source does not mark a tool a live source still syncs", () => {
  // Sources are unioned by tool name, so a project that re-onboarded under a
  // new source id carries every tool twice: once under the source that went
  // quiet, once under the one publishing now. Flagging the row on the quiet
  // half told an operator their whole catalog was stale while snapshots were
  // arriving every minute.
  const rows = buildToolsCatalogRows(
    [
      tool({ name: "resynced", sources: [source("stale"), source("fresh")] }),
      tool({ name: "abandoned", sources: [source("stale"), source("stale")] }),
      tool({ name: "observed-only", sources: [] }),
    ],
    new Map(),
  );

  assert.equal(rows[0].stale, false, "a live source vouches for the row");
  assert.equal(rows[1].stale, true, "every source quiet is genuinely stale");
  assert.equal(rows[2].stale, false, "no sources is not the same as stale");
});

test("filtering matches name or description, case-insensitively", () => {
  const rows = buildToolsCatalogRows(
    [
      tool({ name: "read_file", description: "Reads a file from disk" }),
      tool({ name: "send_email", description: "Delivers a message" }),
    ],
    new Map(),
  );

  const byName = filterToolsCatalogRows(rows, { query: "READ", provenance: "all" });
  const byDescription = filterToolsCatalogRows(rows, {
    query: "message",
    provenance: "all",
  });
  const miss = filterToolsCatalogRows(rows, { query: "zzz", provenance: "all" });

  assert.deepEqual(
    byName.map((r) => r.tool.name),
    ["read_file"],
  );
  assert.deepEqual(
    byDescription.map((r) => r.tool.name),
    ["send_email"],
  );
  assert.deepEqual(miss, []);
});

test("the provenance facet and the query compose", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "read_managed" }), tool({ name: "read_observed" })],
    new Map<string, RuntimeCatalogEntry>([["read_managed", definition("read_managed")]]),
  );

  const managed = filterToolsCatalogRows(rows, {
    query: "read",
    provenance: "managed",
  });

  assert.deepEqual(
    managed.map((r) => r.tool.name),
    ["read_managed"],
  );
});

test("the default sort reproduces the previous hardcoded order", () => {
  // calls desc, then tokens desc, then name asc.
  const rows = buildToolsCatalogRows(
    [
      tool({ name: "b", calls: 5, tokens: 10 }),
      tool({ name: "a", calls: 5, tokens: 10 }),
      tool({ name: "c", calls: 5, tokens: 99 }),
      tool({ name: "d", calls: 9, tokens: 1 }),
    ],
    new Map(),
  );

  const sorted = sortToolsCatalogRows(rows, "calls", "desc");

  assert.deepEqual(
    sorted.map((r) => r.tool.name),
    ["d", "c", "a", "b"],
  );
});

test("sorting does not mutate the caller's array", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "b", calls: 1 }), tool({ name: "a", calls: 2 })],
    new Map(),
  );
  const before = rows.map((r) => r.tool.name);

  sortToolsCatalogRows(rows, "calls", "desc");

  assert.deepEqual(
    rows.map((r) => r.tool.name),
    before,
  );
});

test("name sorts A→Z ascending and Z→A descending", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "beta" }), tool({ name: "alpha" }), tool({ name: "gamma" })],
    new Map(),
  );

  assert.deepEqual(
    sortToolsCatalogRows(rows, "name", "asc").map((r) => r.tool.name),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(
    sortToolsCatalogRows(rows, "name", "desc").map((r) => r.tool.name),
    ["gamma", "beta", "alpha"],
  );
});

test("never-seen rows sort as oldest, not newest", () => {
  const rows = buildToolsCatalogRows(
    [
      tool({ name: "never", lastSeenAt: null }),
      tool({ name: "recent", lastSeenAt: new Date("2026-08-20T00:00:00Z") }),
    ],
    new Map(),
  );

  assert.deepEqual(
    sortToolsCatalogRows(rows, "lastSeen", "desc").map((r) => r.tool.name),
    ["recent", "never"],
  );
});

test("ties break on name so paging is stable", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "z", calls: 0 }), tool({ name: "a", calls: 0 })],
    new Map(),
  );

  for (const direction of ["asc", "desc"] as const) {
    assert.deepEqual(
      sortToolsCatalogRows(rows, "calls", direction).map((r) => r.tool.name),
      ["a", "z"],
      `${direction} ties still order by name`,
    );
  }
});

test("the view defaults to page 1 of 25, calls descending", () => {
  const view = resolveToolsCatalogView({});

  assert.deepEqual(view, {
    query: "",
    provenance: "all",
    sort: "calls",
    direction: "desc",
    page: 1,
    pageSize: DEFAULT_TOOLS_CATALOG_PAGE_SIZE,
    offset: 0,
  });
});

test("the page is bounded by the filtered total", () => {
  // 92 tools at 25/page is 4 pages; asking for 9 lands on the last one.
  const view = resolveToolsCatalogView({ page: "9" }, 92);

  assert.equal(view.page, 4);
  assert.equal(view.offset, 75);
});

test("garbage params fall back rather than throwing", () => {
  const view = resolveToolsCatalogView({
    page: "-3",
    pageSize: "7",
    sort: "dropTable",
    dir: "sideways",
    provenance: "nonsense",
  });

  assert.equal(view.page, 1);
  assert.equal(view.pageSize, DEFAULT_TOOLS_CATALOG_PAGE_SIZE);
  assert.equal(view.sort, "calls");
  assert.equal(view.direction, "desc");
  assert.equal(view.provenance, "all");
});

test("a page size outside the offered set is rejected", () => {
  assert.equal(resolveToolsCatalogView({ pageSize: "50" }).pageSize, 50);
  assert.equal(resolveToolsCatalogView({ pageSize: "1000" }).pageSize, 25);
});

test("serializing omits defaults and round-trips the rest", () => {
  const untouched = toolsCatalogSearchParams(resolveToolsCatalogView({}));
  assert.equal(untouched.toString(), "", "a default view has a clean URL");

  const params = { q: "read", provenance: "managed", sort: "name", dir: "asc", page: "3" };
  const round = toolsCatalogSearchParams(resolveToolsCatalogView(params));

  assert.equal(round.get("q"), "read");
  assert.equal(round.get("provenance"), "managed");
  assert.equal(round.get("sort"), "name");
  assert.equal(round.get("dir"), "asc");
  assert.equal(round.get("page"), "3");
});

test("the range label reads as a position, and survives an empty page", () => {
  assert.equal(toolsCatalogRangeLabel(0, 25, 92), "1–25 of 92");
  assert.equal(toolsCatalogRangeLabel(75, 17, 92), "76–92 of 92");
  assert.equal(toolsCatalogRangeLabel(0, 0, 0), "0 of 0");
});

test("clicking a column picks its natural direction, then flips", () => {
  const view = { sort: "calls", direction: "desc" } as const;

  assert.equal(nextSortDirection(view, "calls"), "asc", "same column flips");
  assert.equal(nextSortDirection(view, "name"), "asc", "names start A→Z");
  assert.equal(nextSortDirection(view, "tokens"), "desc", "numbers start high");
});

test("a page with no telemetry is detectable so the metric columns can stand down", () => {
  const observed = buildToolsCatalogRows([tool({ name: "seen" })], new Map());
  const definitionsOnly = buildToolsCatalogRows(
    [tool({ name: "unseen", provenance: "absent" })],
    new Map(),
  );

  assert.equal(hasObservedUsage(observed), true);
  assert.equal(hasObservedUsage(definitionsOnly), false);
});

test("the source facet offers only what the catalog contains", () => {
  const rows = buildToolsCatalogRows(
    [tool({ name: "managed" }), tool({ name: "observed" })],
    new Map<string, RuntimeCatalogEntry>([["managed", definition("managed")]]),
  );

  assert.deepEqual(presentProvenances(rows), ["managed", "observed"]);
  assert.deepEqual(
    provenanceFilterChoices(presentProvenances(rows), "all").map((c) => c.value),
    ["all", "managed", "observed"],
    "no Ratel option on a catalog with no Ratel-authored rows",
  );
});

test("a facet that matches nothing is still shown while it is selected", () => {
  // Otherwise a deep link to ?provenance=cloud would silently read as "all".
  const choices = provenanceFilterChoices(["managed"], "cloud");

  assert.deepEqual(
    choices.map((c) => c.value),
    ["all", "managed", "cloud"],
  );
});

test("an empty catalog still offers the all-sources option", () => {
  assert.deepEqual(
    provenanceFilterChoices([], "all").map((c) => c.value),
    ["all"],
  );
});

/* --------------------------------- fixtures -------------------------------- */

function tool(
  overrides: Partial<CatalogTool> & {
    name: string;
    sourceStatus?: "fresh" | "stale" | "inactive";
    provenance?: "otel" | "absent";
  },
): CatalogTool {
  const { sourceStatus, provenance = "otel", ...rest } = overrides;
  return {
    description: "",
    calls: 1,
    callsProvenance: provenance,
    tokens: 4,
    tokensProvenance: provenance,
    costUsd: 0.001,
    costProvenance: provenance,
    lastSeenAt: new Date("2026-08-18T13:00:00.000Z"),
    sources: sourceStatus ? [source(sourceStatus)] : [],
    ...rest,
  };
}

function source(status: "fresh" | "stale" | "inactive") {
  return {
    sourceId: `source-${status}`,
    sourceStatus: status,
    sourceLastSeenAt: new Date("2026-08-18T13:00:00.000Z"),
    factsStartedAt: null,
    toolId: "tool",
    name: "tool",
    description: "",
    searchableDescription: null,
    inputSchema: null,
    outputSchema: null,
    metadata: null,
    calls: 0,
    errors: 0,
    lastUsedAt: null,
  };
}

function definition(name: string): RuntimeCatalogEntry {
  return {
    entryId: name,
    name,
    description: "Agent-facing text",
    tags: [],
    inputSchema: null,
    outputSchema: null,
    searchableDescription: "Agent-facing text",
    searchableDescriptionOverridden: false,
    useCloudDefinitions: false,
    provenance: "events",
    searchableDescriptionOverride: null,
    lastSeenAt: new Date("2026-08-18T12:00:00.000Z"),
  };
}

function observedEntry(name: string): RuntimeCatalogEntry {
  return {
    entryId: null,
    name,
    provenance: "observed",
    lastSeenAt: new Date("2026-08-18T13:00:00.000Z"),
  };
}
