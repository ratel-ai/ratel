import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceCompareHref, buildTraceListHref, toggleTraceSelection } from "./record-table";
import { resolveTraceListView, serializeTraceCursor } from "./view";

test("buildTraceListHref preserves unrelated params, resets stale pagination for filters, and binds next-page cursors", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const currentParams = {
    project: "agent",
    range: "7d",
    rootName: "agent.run",
    tab: "all",
  };
  const current = resolveTraceListView(currentParams, now);
  const cursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
  };
  const paramsWithCursor = {
    ...currentParams,
    cursor: serializeTraceCursor(cursor, current.filters),
  };

  const filtered = new URL(
    buildTraceListHref(
      "/traces",
      paramsWithCursor,
      { rootName: "other.run", errorOnly: true },
      now,
    ),
    "https://ratel.test",
  );
  const paginated = new URL(
    buildTraceListHref("/traces", currentParams, { cursor }, now),
    "https://ratel.test",
  );

  assert.deepEqual(
    {
      filtered: Object.fromEntries(filtered.searchParams),
      paginatedCursor: resolveTraceListView(Object.fromEntries(paginated.searchParams), now)
        .queryOptions.cursor,
    },
    {
      filtered: {
        project: "agent",
        range: "7d",
        rootName: "other.run",
        tab: "all",
        errorOnly: "1",
      },
      paginatedCursor: cursor,
    },
  );
});

test("buildTraceListHref clears filters, drops custom bounds on preset change, and strips stale cursors", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const params = {
    project: "agent",
    range: "custom",
    from: "2026-07-01",
    to: "2026-07-15",
    rootName: "agent.run",
    errorOnly: "1",
    cursor: "stale-token",
  };

  const cleared = buildTraceListHref(
    "/traces",
    params,
    {
      rootName: undefined,
      errorOnly: undefined,
      experiment: undefined,
      arm: undefined,
      cursor: undefined,
    },
    now,
  );
  const presetChanged = buildTraceListHref("/traces", params, { range: "7d" }, now);

  assert.equal(cleared, "/traces?project=agent&range=custom&from=2026-07-01&to=2026-07-15");
  assert.equal(presetChanged, "/traces?project=agent&range=7d&rootName=agent.run&errorOnly=1");
});

test("toggleTraceSelection preserves order, caps at two, and never mutates its input", () => {
  const first = Object.freeze(["trace-a"]);
  const pair = toggleTraceSelection(first, "trace-b");

  assert.deepEqual(pair, ["trace-a", "trace-b"]);
  assert.deepEqual(toggleTraceSelection(pair, "trace-c"), ["trace-a", "trace-b"]);
  assert.deepEqual(toggleTraceSelection(pair, "trace-a"), ["trace-b"]);
  assert.deepEqual(first, ["trace-a"]);
});

test("buildTraceCompareHref preserves the list frame and replaces stale trace ids", () => {
  const href = buildTraceCompareHref(
    "/traces",
    "?project=agent&range=custom&from=2026-07-01&to=2026-07-15&rootName=agent.run&errorOnly=1&cursor=opaque&a=stale&b=older",
    ["left-trace", "right-trace"],
  );

  assert.equal(
    href,
    "/traces/compare?project=agent&range=custom&from=2026-07-01&to=2026-07-15&rootName=agent.run&errorOnly=1&cursor=opaque&a=left-trace&b=right-trace",
  );
  assert.equal(buildTraceCompareHref("/traces", "?project=agent", ["only-one"]), null);
});

test("buildTraceCompareHref uses the scoped trace root", () => {
  assert.equal(
    buildTraceCompareHref("/project/01234567-89ab-cdef-0123-456789abcdef/traces", "?range=7d", [
      "left-trace",
      "right-trace",
    ]),
    "/project/01234567-89ab-cdef-0123-456789abcdef/traces/compare?range=7d&a=left-trace&b=right-trace",
  );
});

test("buildTraceListHref preserves exact tag whitespace only when requested", () => {
  assert.equal(
    buildTraceListHref(
      "/traces",
      {},
      {
        experiment: " ranking/v2 ",
        arm: " candidate ",
        exactTags: true,
      },
    ),
    "/traces?experiment=+ranking%2Fv2+&arm=+candidate+&exactTags=1",
  );
  assert.equal(
    buildTraceListHref(
      "/traces",
      { experiment: " exact ", exactTags: "1" },
      { experiment: " manual " },
    ),
    "/traces?experiment=manual",
  );
});

test("buildTraceListHref updates shared child-span dimensions and invalidates pagination", () => {
  assert.equal(
    buildTraceListHref(
      "/project/p/traces",
      {
        range: "7d",
        name: "chat",
        model: "gpt-4.1",
        tool: "search_web",
        cursor: "stale",
      },
      { name: "execute_tool", model: "gpt-5.5", tool: undefined },
    ),
    "/project/p/traces?range=7d&name=execute_tool&model=gpt-5.5",
  );
});

test("buildTraceListHref binds cursors to every repeated facet selection", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const params = {
    range: "7d",
    facetService: ["api", "worker"],
    facetStatus: ["1", "2"],
  };
  const cursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
  };
  const url = new URL(
    buildTraceListHref("/project/p/traces", params, { cursor }, now),
    "https://ratel.test",
  );

  assert.deepEqual(
    resolveTraceListView(
      {
        range: url.searchParams.get("range") ?? undefined,
        facetService: url.searchParams.getAll("facetService"),
        facetStatus: url.searchParams.getAll("facetStatus"),
        cursor: url.searchParams.get("cursor") ?? undefined,
      },
      now,
    ).queryOptions.cursor,
    cursor,
  );
});

test("buildTraceListHref updates record sort state and drops stale pagination", () => {
  assert.equal(
    buildTraceListHref(
      "/project/p/traces",
      {
        range: "7d",
        rootName: "agent.run",
        cursor: "stale",
        sort: "started",
        direction: "desc",
      },
      { sort: "cost", direction: "asc" },
    ),
    "/project/p/traces?range=7d&rootName=agent.run&sort=cost&direction=asc",
  );
});
