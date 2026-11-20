import assert from "node:assert/strict";
import { test } from "node:test";
import { detailBindings } from "../views/detail/bindings";
import { listBindings } from "../views/list/bindings";
import { seriesBindings } from "../views/series/bindings";
import {
  BindingConfigError,
  detailArgs,
  fillTemplate,
  getPath,
  initialSort,
  type ListConfig,
  listSource,
  parseDetailConfig,
  parseListConfig,
  parseSeriesConfig,
} from "./config";

test("every shipped binding parses", () => {
  for (const binding of listBindings) parseListConfig(binding.tool, binding.config);
  for (const binding of detailBindings) parseDetailConfig(binding.tool, binding.config);
  for (const binding of seriesBindings) parseSeriesConfig(binding.tool, binding.config);
});

test("the list view's detail tools all have a detail binding", () => {
  const details = new Set(detailBindings.map((binding) => binding.tool));
  for (const binding of listBindings) {
    if (binding.config.detail)
      assert.ok(
        details.has(binding.config.detail.tool),
        `${binding.tool} opens ${binding.config.detail.tool}`,
      );
  }
});

const list = {
  rows: "items",
  rowKey: "id",
  title: "name",
  noun: { one: "item", many: "items" },
  columns: [{ key: "name", label: "Name" }],
};

test("a list config names what is wrong and where", () => {
  assert.throws(
    () => parseListConfig("list_x", { ...list, rows: "" }),
    /list_x: config\.rows must be a non-empty string/,
  );
  assert.throws(
    () => parseListConfig("list_x", { ...list, columns: [] }),
    /config\.columns needs at least one column/,
  );
  assert.throws(
    () =>
      parseListConfig("list_x", { ...list, columns: [{ key: "n", label: "N", format: "money" }] }),
    /config\.columns\[0\]\.format must be one of/,
  );
  assert.throws(
    () =>
      parseListConfig("list_x", { ...list, columns: [{ key: "n", label: "N", format: "entity" }] }),
    /config\.columns\[0\]\.noun is required/,
  );
  assert.throws(
    () =>
      parseListConfig("list_x", { ...list, filters: [{ key: "s", label: "S", kind: "range" }] }),
    /config\.filters\[0\]\.kind/,
  );
  assert.throws(
    () => parseListConfig("list_x", { ...list, defaultSort: { key: "name", direction: "up" } }),
    /config\.defaultSort\.direction/,
  );
  assert.throws(
    () => parseListConfig("list_x", { ...list, detail: { tool: "get_x", args: { id: 3 } } }),
    /config\.detail\.args\.id/,
  );
  assert.throws(() => parseListConfig("list_x", null), BindingConfigError);
});

test("a detail config needs a root, a title and fields; sections are checked by kind", () => {
  const detail = { root: "", title: "name", fields: [{ key: "name", label: "Name" }] };
  parseDetailConfig("get_x", detail);
  assert.throws(() => parseDetailConfig("get_x", { ...detail, root: undefined }), /config\.root/);
  assert.throws(
    () =>
      parseDetailConfig("get_x", { ...detail, sections: [{ title: "T", kind: "grid", key: "x" }] }),
    /sections\[0\]\.kind/,
  );
  assert.throws(
    () =>
      parseDetailConfig("get_x", {
        ...detail,
        sections: [{ title: "T", kind: "table", key: "x" }],
      }),
    /sections\[0\]\.columns must be an array/,
  );
});

test("a series config has one measure and 2 to 5 stats", () => {
  const series = {
    rows: "series",
    x: "day",
    measure: { key: "cost", label: "Cost", format: "currency" },
    stats: [
      { label: "A", key: "a", aggregate: "sum" },
      { label: "B", key: "b", aggregate: "max" },
    ],
  };
  parseSeriesConfig("get_s", series);
  assert.throws(
    () => parseSeriesConfig("get_s", { ...series, stats: series.stats.slice(0, 1) }),
    /2 to 5 stats/,
  );
  assert.throws(
    () =>
      parseSeriesConfig("get_s", {
        ...series,
        stats: [...series.stats.slice(0, 1), { label: "C", key: "c", aggregate: "median" }],
      }),
    /aggregate/,
  );
  // "window" reads the tool's own figure for the whole window from data.
  parseSeriesConfig("get_s", {
    ...series,
    stats: [...series.stats, { label: "p95", key: "kpis.p95LatencyMs", aggregate: "window" }],
    empty: { title: "None" },
  });
});

test("paths read nested values; an empty path is the value itself", () => {
  const data = { a: { b: [{ c: 1 }] } };
  assert.equal(getPath(data, "a.b.0.c"), 1);
  assert.equal(getPath(data, "a.x.y"), undefined);
  assert.equal(getPath(data, ""), data);
});

test("detail arguments come from the row; a missing one is left out", () => {
  assert.deepEqual(detailArgs({ traceId: "traceId", other: "missing" }, { traceId: "t1" }), {
    traceId: "t1",
  });
  assert.deepEqual(detailArgs({ traceId: "traceId" }, {}), {});
});

test("console paths fill from the result and the input, or are null", () => {
  assert.equal(
    fillTemplate("/projects/{projectId}/t/{id}", { id: "a b" }, { projectId: "p" }),
    "/projects/p/t/a%20b",
  );
  assert.equal(fillTemplate("/t/{id}", {}), null);
});

const runs: Pick<ListConfig, "defaultSort" | "sortArg"> = {
  defaultSort: { key: "startedAt", direction: "desc" },
  sortArg: {
    started: { key: "startedAt", direction: "desc" },
    duration: { key: "durationMs", direction: "desc" },
    name: { key: "name", direction: "asc" },
  },
};

test("a list starts on the binding's sort, and sorts its rows itself", () => {
  assert.deepEqual(initialSort(runs, null), {
    sort: { id: "startedAt", direction: "desc" },
    serverOrder: false,
  });
  assert.deepEqual(initialSort(runs, { projectId: "p" }), {
    sort: { id: "startedAt", direction: "desc" },
    serverOrder: false,
  });
  assert.deepEqual(initialSort({}, {}), { sort: undefined, serverOrder: false });
});

test("a call that names a sort keeps the tool's order, and its column reads as sorted", () => {
  // The slowest runs stay slowest first: the view does not sort the page again by start time.
  assert.deepEqual(initialSort(runs, { sort: "duration" }), {
    sort: { id: "durationMs", direction: "desc" },
    serverOrder: true,
  });
  // The call's own direction wins over the column's usual one.
  assert.deepEqual(initialSort(runs, { sort: "name", direction: "desc" }), {
    sort: { id: "name", direction: "desc" },
    serverOrder: true,
  });
  // A sort with no column here (skills by runs): the tool's order, no header marked.
  assert.deepEqual(initialSort(runs, { sort: "runs" }), { sort: undefined, serverOrder: true });
  assert.deepEqual(initialSort({ defaultSort: runs.defaultSort }, { sort: "duration" }), {
    sort: undefined,
    serverOrder: true,
  });
});

test("every sort a bound tool takes points at a column of its list", () => {
  for (const binding of listBindings) {
    const config = parseListConfig(binding.tool, binding.config);
    for (const [value, column] of Object.entries(config.sortArg ?? {})) {
      assert.ok(
        config.columns.some((item) => item.key === column.key),
        `${binding.tool} sort=${value}: no column ${column.key}`,
      );
    }
  }
});

const issues: ListConfig = {
  rows: "insights",
  rowKey: "id",
  title: "title",
  noun: { one: "issue", many: "issues" },
  columns: [{ key: "title", label: "Issue" }],
  defaultSort: { key: "title", direction: "asc" },
  detail: { tool: "get_fix", args: { insightId: "id" } },
  empty: { title: "No issues" },
  fromView: {
    kind: "health_issue_rows",
    rows: "rows",
    rowKey: "key",
    title: "title",
    columns: [
      { key: "title", label: "Issue" },
      { key: "points", label: "If fixed", format: "points" },
    ],
  },
};

test("a list is drawn from the tool's view model when the binding names it and the result carries it", () => {
  const view = {
    kind: "health_issue_rows",
    rows: [{ key: "slow", title: "Slow tool", points: 7 }],
  };
  const data = { insights: [{ id: "a" }, { id: "b" }] };
  const drawn = listSource(issues, { data, view });
  assert.equal(drawn.source, view);
  assert.equal(drawn.config.rows, "rows");
  assert.equal(drawn.config.rowKey, "key");
  assert.deepEqual(
    drawn.config.columns.map((column) => column.key),
    ["title", "points"],
  );
  // The binding's words carry over; its sort, detail and paging are the data's, so they do not.
  assert.deepEqual(drawn.config.noun, issues.noun);
  assert.deepEqual(drawn.config.empty, issues.empty);
  assert.equal(drawn.config.defaultSort, undefined);
  assert.equal(drawn.config.detail, undefined);
  assert.equal(drawn.config.fromView, undefined);

  // No view model, or another view's: the tool's own rows.
  assert.deepEqual(listSource(issues, { data }), { config: issues, source: data });
  assert.deepEqual(listSource(issues, { data, view: { kind: "session_chat" } }), {
    config: issues,
    source: data,
  });
  const plain = { ...issues, fromView: undefined };
  assert.deepEqual(listSource(plain, { data, view }), { config: plain, source: data });
});

test("a list's sort arguments and view model config are checked like the rest", () => {
  parseListConfig("list_x", issues);
  assert.throws(
    () =>
      parseListConfig("list_x", { ...issues, sortArg: { name: { key: "name", direction: "up" } } }),
    /config\.sortArg\.name\.direction must be one of asc, desc/,
  );
  assert.throws(
    () => parseListConfig("list_x", { ...issues, fromView: { ...issues.fromView, kind: "" } }),
    /config\.fromView\.kind must be a non-empty string/,
  );
  assert.throws(
    () => parseListConfig("list_x", { ...issues, fromView: { ...issues.fromView, columns: [] } }),
    /list_x \(fromView\): config\.columns needs at least one column/,
  );
});
