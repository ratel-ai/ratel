import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComparisonFilterSelection } from "@/lib/synthesis/experiments/calibration-types";
import {
  calibrationDetailPath,
  calibrationMismatchesPath,
  calibrationSelectionPath,
  comparisonFilterParam,
  comparisonRangeLabel,
  comparisonSearchParams,
  formatScore,
  latencyDelta,
  nextOpenComparisonRow,
  outcomeTone,
  resolveComparisonBrowserView,
  resolveComparisonSelection,
  singleSearchParam,
  toggleComparisonFacet,
} from "./calibration-view";

test("resolveComparisonSelection defaults to flagged mismatches with no facet", () => {
  assert.deepEqual(resolveComparisonSelection(undefined, undefined), {
    scope: "mismatch",
    facets: [],
    match: "any",
  });
  assert.deepEqual(resolveComparisonSelection("bogus", "nonsense"), {
    scope: "mismatch",
    facets: [],
    match: "any",
  });
});

test("resolveComparisonSelection reads comma-separated facets and the match mode", () => {
  assert.deepEqual(resolveComparisonSelection("order,top1", "all"), {
    scope: "mismatch",
    facets: ["top1", "order"],
    match: "all",
  });
  assert.deepEqual(resolveComparisonSelection("top1,bogus,top1", undefined), {
    scope: "mismatch",
    facets: ["top1"],
    match: "any",
  });
});

test("resolveComparisonSelection keeps the legacy single-value URLs working", () => {
  assert.deepEqual(resolveComparisonSelection("all", undefined), {
    scope: "all",
    facets: [],
    match: "any",
  });
  assert.deepEqual(resolveComparisonSelection("mismatch", undefined), {
    scope: "mismatch",
    facets: [],
    match: "any",
  });
  assert.deepEqual(resolveComparisonSelection("outcome", undefined), {
    scope: "mismatch",
    facets: ["outcome"],
    match: "any",
  });
});

test("resolveComparisonSelection widens the scope when facets ride along with all", () => {
  assert.deepEqual(resolveComparisonSelection("all,missing", undefined), {
    scope: "all",
    facets: ["missing"],
    match: "any",
  });
});

test("comparisonFilterParam round-trips a selection through the URL", () => {
  for (const raw of ["mismatch", "all", "order,top1", "all,missing"]) {
    const selection = resolveComparisonSelection(raw, "all");
    assert.deepEqual(
      resolveComparisonSelection(comparisonFilterParam(selection), "all"),
      selection,
    );
  }
  assert.equal(comparisonFilterParam({ scope: "mismatch", facets: [], match: "any" }), "mismatch");
  assert.equal(
    comparisonFilterParam({
      scope: "all",
      facets: ["top1", "order"],
      match: "any",
    }),
    "all,top1,order",
  );
});

test("toggleComparisonFacet adds and removes facets in canonical order", () => {
  const base: ComparisonFilterSelection = {
    scope: "mismatch",
    facets: [],
    match: "any",
  };
  const withOrder = toggleComparisonFacet(base, "order");
  assert.deepEqual(withOrder.facets, ["order"]);
  assert.deepEqual(toggleComparisonFacet(withOrder, "top1").facets, ["top1", "order"]);
  assert.deepEqual(toggleComparisonFacet(withOrder, "order").facets, []);
  assert.equal(toggleComparisonFacet(withOrder, "top1").match, "any");
});

test("resolveComparisonBrowserView resolves selection and pagination together", () => {
  assert.deepEqual(
    resolveComparisonBrowserView({
      comparisons: "top1,order",
      comparisonMatch: "all",
      comparisonPage: "3",
      comparisonPageSize: "100",
    }),
    {
      selection: { scope: "mismatch", facets: ["top1", "order"], match: "all" },
      page: 3,
      pageSize: 100,
      offset: 200,
    },
  );
});

test("resolveComparisonBrowserView safely defaults invalid pagination", () => {
  assert.deepEqual(
    resolveComparisonBrowserView({
      comparisons: "bogus",
      comparisonPage: "-1",
      comparisonPageSize: "999",
    }),
    {
      selection: { scope: "mismatch", facets: [], match: "any" },
      page: 1,
      pageSize: 25,
      offset: 0,
    },
  );
});

test("resolveComparisonBrowserView clamps the page to the filtered result count", () => {
  assert.deepEqual(
    resolveComparisonBrowserView(
      {
        comparisons: "mismatch",
        comparisonPage: "1000000000",
        comparisonPageSize: "25",
      },
      40,
    ),
    {
      selection: { scope: "mismatch", facets: [], match: "any" },
      page: 2,
      pageSize: 25,
      offset: 25,
    },
  );
});

test("singleSearchParam takes the first value from a repeated query parameter", () => {
  assert.equal(singleSearchParam("top1"), "top1");
  assert.equal(singleSearchParam(["top1", "order"]), "top1");
  assert.equal(singleSearchParam([]), undefined);
  assert.equal(singleSearchParam(undefined), undefined);
});

test("comparisonRangeLabel reports the current offset range", () => {
  assert.equal(comparisonRangeLabel(0, 25, 300), "1–25 of 300");
  assert.equal(comparisonRangeLabel(25, 25, 300), "26–50 of 300");
  assert.equal(comparisonRangeLabel(290, 10, 300), "291–300 of 300");
  assert.equal(comparisonRangeLabel(0, 0, 0), "0 of 0");
});

test("comparisonSearchParams keeps the range params and omits defaults", () => {
  const base = new URLSearchParams({ project: "acme", range: "24h" });
  assert.equal(
    comparisonSearchParams(base, {
      selection: { scope: "mismatch", facets: [], match: "any" },
      page: 1,
      pageSize: 25,
      offset: 0,
    }).toString(),
    "project=acme&range=24h&comparisons=mismatch&comparisonPageSize=25",
  );
  assert.equal(
    comparisonSearchParams(base, {
      selection: { scope: "mismatch", facets: ["top1", "order"], match: "all" },
      page: 2,
      pageSize: 50,
      offset: 50,
    }).toString(),
    "project=acme&range=24h&comparisons=top1%2Corder&comparisonMatch=all&comparisonPage=2&comparisonPageSize=50",
  );
});

test("comparisonSearchParams removes stale non-default browser params", () => {
  const base = new URLSearchParams({
    project: "acme",
    comparisonMatch: "all",
    comparisonPage: "4",
  });

  assert.equal(
    comparisonSearchParams(base, {
      selection: { scope: "mismatch", facets: ["top1"], match: "any" },
      page: 1,
      pageSize: 25,
      offset: 0,
    }).toString(),
    "project=acme&comparisons=top1&comparisonPageSize=25",
  );
});

test("formatScore renders a 0..1 score as a percentage or a dash", () => {
  assert.equal(formatScore(0.8724), "87%");
  assert.equal(formatScore(1), "100%");
  assert.equal(formatScore(0), "0%");
  assert.equal(formatScore(null), "—");
});

test("outcomeTone maps SDK outcomes onto presentation tones", () => {
  assert.equal(outcomeTone("ok"), "ok");
  assert.equal(outcomeTone("empty"), "warn");
  assert.equal(outcomeTone("error"), "error");
  assert.equal(outcomeTone("timeout"), "error");
  assert.equal(outcomeTone(null), "muted");
  assert.equal(outcomeTone("surprise"), "muted");
});

test("latencyDelta compares shadow against the served baseline", () => {
  assert.deepEqual(latencyDelta(100, 250), {
    absolute: 150,
    relative: 1.5,
  });
  assert.deepEqual(latencyDelta(0, 50), { absolute: 50, relative: null });
  assert.equal(latencyDelta(null, 50), null);
  assert.equal(latencyDelta(100, null), null);
});

test("calibrationDetailPath keeps experiment names reversible under the scoped base", () => {
  assert.equal(
    calibrationDetailPath("/project/p-1/calibration", "mcp_search_operations"),
    "/project/p-1/calibration/~mcp_search_operations",
  );
  assert.equal(
    calibrationDetailPath("/project/p-1/calibration", "retrieval v2/beta"),
    "/project/p-1/calibration/~retrieval%20v2%2Fbeta",
  );
});

test("calibrationMismatchesPath nests disagreements under the experiment", () => {
  assert.equal(
    calibrationMismatchesPath("/project/p-1/calibration", "mcp_search_operations"),
    "/project/p-1/calibration/~mcp_search_operations/mismatches",
  );
});

test("calibrationSelectionPath nests the encoded selection under the experiment", () => {
  assert.equal(
    calibrationSelectionPath("/project/p-1/calibration", "mcp_search_operations", "sel 42/a"),
    "/project/p-1/calibration/~mcp_search_operations/selection/sel%2042%2Fa",
  );
});

test("switching rows keeps the newly opened one, not the one that closed", () => {
  // The regression: opening B while A is open makes React close A, and the
  // browser answers with A's own toggle event AFTER B has been recorded.
  // Treating that as "the user closed a row" wiped B out: the previous row
  // collapsed and the clicked one never appeared.
  let open = nextOpenComparisonRow(null, "a", true);
  assert.equal(open, "a");

  open = nextOpenComparisonRow(open, "b", true);
  assert.equal(open, "b", "clicking b opens b");

  open = nextOpenComparisonRow(open, "a", false);
  assert.equal(open, "b", "a's own close event must not clear b");
});

test("closing the open row collapses the accordion", () => {
  assert.equal(nextOpenComparisonRow("a", "a", false), null);
});

test("a close naming some other row is ignored", () => {
  assert.equal(nextOpenComparisonRow("a", "b", false), "a");
  assert.equal(nextOpenComparisonRow(null, "b", false), null);
});
