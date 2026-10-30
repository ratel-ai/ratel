import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import type { SpanSummary, TraceSummary } from "./queries";
import {
  buildOperationsHref,
  buildSpanListHref,
  buildTraceTabHref,
  parseSpanCursor,
  parseTraceCursor,
  resolveOperationsView,
  resolveSpanListView,
  resolveTraceCompareIds,
  resolveTraceListView,
  serializeSpanCursor,
  serializeTraceCursor,
  toSpanSummaryView,
  toTraceSpanView,
  toTraceSummaryView,
} from "./view";

test("trace views serialize dates without formatting or coercing raw values", () => {
  const summary = traceSummary();
  const span = otelSpan();

  assert.deepEqual(toTraceSummaryView(summary), {
    ...summary,
    startedAt: "2026-07-30T10:00:00.000Z",
    endedAt: "2026-07-30T10:00:01.250Z",
  });
  const clientSpan: Partial<OtelSpan> = {
    ...span,
    startedAt: undefined,
    endedAt: undefined,
  };
  delete clientSpan.id;
  delete clientSpan.projectId;
  delete clientSpan.traceId;
  delete clientSpan.startedAt;
  delete clientSpan.endedAt;
  assert.deepEqual(toTraceSpanView(span), {
    ...clientSpan,
    startedAt: "2026-07-30T10:00:00.125Z",
    endedAt: "2026-07-30T10:00:00.375Z",
  });
  assert.equal(toTraceSpanView(span).costUsd, "0.000125");
  assert.deepEqual(toTraceSpanView(span).attributes, {
    "gen_ai.operation.name": "chat",
  });
});

test("resolveTraceListView defaults to a seven-day UTC window and maps filters to query options", () => {
  const view = resolveTraceListView(
    {
      project: "agent",
      rootName: " agent.run ",
      errorOnly: "1",
      experiment: " ranking-v2 ",
      arm: " candidate ",
    },
    new Date("2026-07-30T18:45:00.000Z"),
  );

  assert.deepEqual(view, {
    range: {
      preset: "7d",
      from: "2026-07-24",
      to: "2026-07-30",
      since: new Date("2026-07-24T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      days: [
        "2026-07-24",
        "2026-07-25",
        "2026-07-26",
        "2026-07-27",
        "2026-07-28",
        "2026-07-29",
        "2026-07-30",
      ],
      label: "last 7 days",
    },
    filters: {
      project: "agent",
      range: "7d",
      from: "2026-07-24",
      to: "2026-07-30",
      rootName: "agent.run",
      name: "",
      model: "",
      tool: "",
      errorOnly: true,
      experiment: "ranking-v2",
      arm: "candidate",
      exactTags: false,
      sort: "started",
      direction: "desc",
    },
    queryOptions: {
      since: new Date("2026-07-24T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      rootName: "agent.run",
      errorOnly: true,
      experiment: "ranking-v2",
      arm: "candidate",
      sort: "started",
      direction: "desc",
    },
  });
});

test("span views resolve shared filters, root scope, and cursor context", () => {
  const now = new Date("2026-07-30T18:45:00.000Z");
  const filters = {
    project: "agent",
    range: "7d",
    scope: "root",
    name: " execute_tool ",
    model: " gpt-5.5 ",
    tool: " search_docs ",
    experiment: " ranking-v2 ",
    errorOnly: "true",
  };
  const current = resolveSpanListView(filters, now);
  const cursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
  };
  const token = serializeSpanCursor(cursor, current.filters);
  const resolved = resolveSpanListView({ ...filters, cursor: token }, now);

  assert.deepEqual(resolved.queryOptions, {
    since: new Date("2026-07-24T00:00:00.000Z"),
    until: new Date("2026-07-31T00:00:00.000Z"),
    scope: "root",
    name: "execute_tool",
    model: "gpt-5.5",
    tool: "search_docs",
    experiment: "ranking-v2",
    arm: undefined,
    errorOnly: true,
    sort: "started",
    direction: "desc",
    cursor,
  });
  assert.deepEqual(parseSpanCursor(token, current.filters), cursor);
  assert.equal(parseSpanCursor(token, { ...current.filters, tool: "other" }), undefined);
});

test("trace views normalize repeated facets and measure ranges into every query", () => {
  const params = {
    facetService: [" api ", "worker", "api"],
    facetName: ["chat", ""],
    facetStatus: ["2", "bad", "1"],
    facetKind: "3",
    facetEnvironment: " production ",
    facetModel: " gpt-5.5 ",
    facetExperiment: " ranking-v2 ",
    facetArm: " candidate ",
    minDurationMs: "100",
    maxDurationMs: "10",
    minTokens: "20",
    maxTokens: "200",
    minCostUsd: "0.01",
    maxCostUsd: "1.5",
  };
  const spans = resolveSpanListView(params);
  const traces = resolveTraceListView(params);
  const operations = resolveOperationsView(params);
  const expected = {
    services: ["api", "worker"],
    names: ["chat"],
    statuses: [2, 1],
    kinds: [3],
    environments: ["production"],
    models: ["gpt-5.5"],
    experiments: ["ranking-v2"],
    arms: ["candidate"],
    minDurationMs: 10,
    maxDurationMs: 100,
    minTokens: 20,
    maxTokens: 200,
    minCostUsd: 0.01,
    maxCostUsd: 1.5,
  };

  assert.deepEqual(spans.filters.facets, expected);
  assert.deepEqual(traces.filters.facets, expected);
  assert.deepEqual(operations.filters.facets, expected);
  assert.deepEqual(pickFacets(spans.queryOptions), expected);
  assert.deepEqual(pickFacets(traces.queryOptions), expected);
  assert.deepEqual(pickFacets(operations.queryOptions), expected);
  assert.equal(
    buildTraceTabHref("/project/p/traces/spans", params),
    "/project/p/traces/spans?facetService=+api+&facetService=worker&facetService=api&facetName=chat&facetName=&facetStatus=2&facetStatus=bad&facetStatus=1&facetKind=3&facetEnvironment=+production+&facetModel=+gpt-5.5+&facetExperiment=+ranking-v2+&facetArm=+candidate+&minDurationMs=100&maxDurationMs=10&minTokens=20&maxTokens=200&minCostUsd=0.01&maxCostUsd=1.5",
  );
});

test("operation views validate grouping and sorting while mapping shared filters", () => {
  const view = resolveOperationsView(
    {
      range: "30d",
      groupBy: "tool",
      sort: "p99",
      direction: "asc",
      name: " execute_tool ",
      model: " gpt-5.5 ",
      tool: " search_docs ",
      experiment: " ranking-v2 ",
      errorOnly: "1",
    },
    new Date("2026-07-30T12:00:00.000Z"),
  );

  assert.deepEqual(view.queryOptions, {
    since: new Date("2026-07-01T00:00:00.000Z"),
    until: new Date("2026-07-31T00:00:00.000Z"),
    groupBy: "tool",
    sort: "p99",
    direction: "asc",
    name: "execute_tool",
    model: "gpt-5.5",
    tool: "search_docs",
    experiment: "ranking-v2",
    errorOnly: true,
  });
  assert.deepEqual(resolveOperationsView({ groupBy: "bad", sort: "bad" }).filters, {
    project: "",
    range: "7d",
    from: resolveOperationsView({}).range.from,
    to: resolveOperationsView({}).range.to,
    name: "",
    model: "",
    tool: "",
    experiment: "",
    errorOnly: false,
    groupBy: "name",
    sort: "count",
    direction: "desc",
  });
});

test("trace and span views validate record sorts and map them to list queries", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const traces = resolveTraceListView({ sort: "cost", direction: "asc" }, now);
  const spans = resolveSpanListView({ sort: "duration", direction: "asc" }, now);

  assert.deepEqual(
    {
      traceFilters: {
        sort: traces.filters.sort,
        direction: traces.filters.direction,
      },
      traceQuery: {
        sort: traces.queryOptions.sort,
        direction: traces.queryOptions.direction,
      },
      spanFilters: {
        sort: spans.filters.sort,
        direction: spans.filters.direction,
      },
      spanQuery: {
        sort: spans.queryOptions.sort,
        direction: spans.queryOptions.direction,
      },
      invalidTrace: resolveTraceListView({ sort: "unknown", direction: "sideways" }, now).filters,
      invalidSpan: resolveSpanListView({ sort: "unknown", direction: "sideways" }, now).filters,
    },
    {
      traceFilters: { sort: "cost", direction: "asc" },
      traceQuery: { sort: "cost", direction: "asc" },
      spanFilters: { sort: "duration", direction: "asc" },
      spanQuery: { sort: "duration", direction: "asc" },
      invalidTrace: {
        ...resolveTraceListView({}, now).filters,
        sort: "started",
        direction: "desc",
      },
      invalidSpan: {
        ...resolveSpanListView({}, now).filters,
        sort: "started",
        direction: "desc",
      },
    },
  );
});

test("trace tab links preserve the shared frame, drop cursors, and update table state", () => {
  const params = {
    range: "custom",
    from: "2026-07-01",
    to: "2026-07-15",
    name: "chat",
    model: "gpt-5.5",
    tool: "search_docs",
    experiment: "ranking-v2",
    errorOnly: "1",
    scope: "root",
    cursor: "stale",
  };

  assert.equal(
    buildTraceTabHref("/project/p/traces/operations", params),
    "/project/p/traces/operations?range=custom&from=2026-07-01&to=2026-07-15&name=chat&model=gpt-5.5&tool=search_docs&experiment=ranking-v2&errorOnly=1&scope=root",
  );
  assert.equal(
    buildOperationsHref("/project/p/traces/operations", params, {
      groupBy: "model",
      sort: "cost",
      direction: "asc",
    }),
    "/project/p/traces/operations?range=custom&from=2026-07-01&to=2026-07-15&name=chat&model=gpt-5.5&tool=search_docs&experiment=ranking-v2&errorOnly=1&scope=root&groupBy=model&sort=cost&direction=asc",
  );
});

test("span hrefs bind cursor tokens and span summaries serialize timestamps", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const cursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
  };
  const href = buildSpanListHref(
    "/project/p/traces/spans",
    { range: "7d", name: "chat" },
    { cursor },
    now,
  );
  const parsed = new URL(href, "https://cloud.ratel.sh");

  assert.deepEqual(
    resolveSpanListView(Object.fromEntries(parsed.searchParams), now).queryOptions.cursor,
    cursor,
  );
  assert.deepEqual(toSpanSummaryView(spanSummary()), {
    ...spanSummary(),
    startedAt: "2026-07-30T10:00:00.000Z",
  });
});

test("record sort hrefs preserve filters and reset pagination", () => {
  assert.equal(
    buildSpanListHref(
      "/project/p/traces/spans",
      { name: "chat", cursor: "stale", sort: "started", direction: "desc" },
      { sort: "tokens", direction: "asc" },
    ),
    "/project/p/traces/spans?name=chat&sort=tokens&direction=asc",
  );
});

test("resolveTraceListView preserves exact experiment and arm tag identity", () => {
  const view = resolveTraceListView(
    {
      experiment: " ranking/v2 ",
      arm: " candidate + beta ",
      exactTags: "1",
    },
    new Date("2026-07-30T12:00:00.000Z"),
  );

  assert.equal(view.filters.experiment, " ranking/v2 ");
  assert.equal(view.filters.arm, " candidate + beta ");
  assert.equal(view.filters.exactTags, true);
  assert.equal(view.queryOptions.experiment, " ranking/v2 ");
  assert.equal(view.queryOptions.arm, " candidate + beta ");
});

test("resolveSpanListView carries the arm and exact-tag identity a finding links with", () => {
  // The evidence link on an experiment finding is
  // `?experiment=…&arm=…&exactTags=1`. The span view backs the workspace filter
  // bar and the facet counts, so dropping either here left the records filtered
  // while the bar above them rendered empty — and the next Apply, which
  // re-submits only what the bar holds, silently widened the query to every arm.
  const view = resolveSpanListView(
    { experiment: " retrieval/v2 ", arm: " candidate + beta ", exactTags: "1" },
    new Date("2026-07-30T12:00:00.000Z"),
  );

  assert.equal(view.filters.experiment, " retrieval/v2 ");
  assert.equal(view.filters.arm, " candidate + beta ");
  assert.equal(view.filters.exactTags, true);
  assert.equal(view.queryOptions.arm, " candidate + beta ");
});

test("span list hrefs can clear the arm and exact-tag pair a finding set", () => {
  const cleared = buildSpanListHref(
    "/project/p1/traces",
    { project: "agent", experiment: "retrieval-v2", arm: "candidate", exactTags: "1" },
    { experiment: null, arm: null, exactTags: null },
  );

  assert.equal(cleared, "/project/p1/traces?project=agent");
});

test("resolveTraceListView normalizes a reversed custom range with an exclusive upper bound", () => {
  const view = resolveTraceListView(
    {
      range: "custom",
      from: "2026-07-31",
      to: "2026-07-29",
      errorOnly: "true",
    },
    new Date("2026-08-10T12:00:00.000Z"),
  );

  assert.deepEqual(
    {
      preset: view.range.preset,
      from: view.range.from,
      to: view.range.to,
      since: view.queryOptions.since,
      until: view.queryOptions.until,
      errorOnly: view.queryOptions.errorOnly,
    },
    {
      preset: "custom",
      from: "2026-07-29",
      to: "2026-07-31",
      since: new Date("2026-07-29T00:00:00.000Z"),
      until: new Date("2026-08-01T00:00:00.000Z"),
      errorOnly: true,
    },
  );
});

test("resolveTraceListView supports every DateRangeControl preset", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  assert.deepEqual(
    ["7d", "14d", "30d", "3m", "12m"].map((range) => {
      const view = resolveTraceListView({ range }, now);
      return [view.range.preset, view.range.from, view.range.to];
    }),
    [
      ["7d", "2026-07-24", "2026-07-30"],
      ["14d", "2026-07-17", "2026-07-30"],
      ["30d", "2026-07-01", "2026-07-30"],
      ["3m", "2026-05-01", "2026-07-30"],
      ["12m", "2025-07-31", "2026-07-30"],
    ],
  );
});

test("trace cursors round-trip only within the normalized filter context", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const current = resolveTraceListView(
    { project: "agent", range: "7d", rootName: "agent.run" },
    now,
  );
  const cursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
  };
  const token = serializeTraceCursor(cursor, current.filters);

  assert.deepEqual(
    {
      parsed: parseTraceCursor(token, current.filters),
      resolved: resolveTraceListView(
        {
          project: "agent",
          range: "7d",
          rootName: "agent.run",
          cursor: token,
        },
        now,
      ).queryOptions.cursor,
      changedFilter: parseTraceCursor(token, {
        ...current.filters,
        rootName: "other.run",
      }),
      malformed: parseTraceCursor("not-a-cursor", current.filters),
    },
    {
      parsed: cursor,
      resolved: cursor,
      changedFilter: undefined,
      malformed: undefined,
    },
  );
});

test("sorted record cursors preserve their metric and reject changed sort state", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const traceView = resolveTraceListView({ sort: "cost", direction: "asc" }, now);
  const spanView = resolveSpanListView({ sort: "tokens", direction: "desc" }, now);
  const traceCursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
    sortValue: 0.0042,
  };
  const spanCursor = {
    startedAt: new Date("2026-07-29T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
    sortValue: 420,
  };
  const traceToken = serializeTraceCursor(traceCursor, traceView.filters);
  const spanToken = serializeSpanCursor(spanCursor, spanView.filters);

  assert.deepEqual(parseTraceCursor(traceToken, traceView.filters), traceCursor);
  assert.deepEqual(parseSpanCursor(spanToken, spanView.filters), spanCursor);
  assert.equal(
    parseTraceCursor(traceToken, { ...traceView.filters, direction: "desc" }),
    undefined,
  );
  assert.equal(parseSpanCursor(spanToken, { ...spanView.filters, sort: "cost" }), undefined);
});

test("resolveTraceCompareIds accepts only two distinct nonzero OTel trace ids", () => {
  const left = "0123456789abcdef0123456789abcdef";
  const right = "fedcba9876543210fedcba9876543210";

  assert.deepEqual(
    resolveTraceCompareIds({
      a: [` ${left} `, "ignored"],
      b: right,
    }),
    [left, right],
  );
  assert.equal(resolveTraceCompareIds({ a: left }), null);
  assert.equal(resolveTraceCompareIds({ a: left, b: left }), null);
  assert.equal(
    resolveTraceCompareIds({
      a: "00000000000000000000000000000000",
      b: right,
    }),
    null,
  );
  assert.equal(resolveTraceCompareIds({ a: "not-a-trace", b: right }), null);
});

test("resolveTraceCompareIds normalizes uppercase ids to the stored lowercase form", () => {
  const left = "0123456789abcdef0123456789abcdef";
  const right = "fedcba9876543210fedcba9876543210";

  assert.deepEqual(resolveTraceCompareIds({ a: left.toUpperCase(), b: right.toUpperCase() }), [
    left,
    right,
  ]);
  // Same trace in different case is not a valid comparison pair.
  assert.equal(resolveTraceCompareIds({ a: left.toUpperCase(), b: left }), null);
});

test("resolveTraceListView caps crafted custom ranges at 372 days", () => {
  const view = resolveTraceListView({
    range: "custom",
    from: "2020-01-01",
    to: "2026-07-30",
  });

  assert.deepEqual(
    {
      from: view.range.from,
      to: view.range.to,
      dayCount: view.range.days.length,
      since: view.queryOptions.since,
      until: view.queryOptions.until,
    },
    {
      from: "2025-07-24",
      to: "2026-07-30",
      dayCount: 372,
      since: new Date("2025-07-24T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
    },
  );
});

test("resolveTraceListView rejects a custom range without a valid exclusive upper day", () => {
  const view = resolveTraceListView(
    {
      range: "custom",
      from: "9999-12-31",
      to: "9999-12-31",
    },
    new Date("2026-07-30T12:00:00.000Z"),
  );

  assert.deepEqual(
    {
      preset: view.range.preset,
      from: view.range.from,
      to: view.range.to,
      since: view.queryOptions.since,
      until: view.queryOptions.until,
    },
    {
      preset: "7d",
      from: "2026-07-24",
      to: "2026-07-30",
      since: new Date("2026-07-24T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
    },
  );
});

function traceSummary(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    rootSpanId: "0123456789abcdef",
    rootName: "agent.run",
    startedAt: new Date("2026-07-30T10:00:00.000Z"),
    endedAt: new Date("2026-07-30T10:00:01.250Z"),
    durationMs: 1_250,
    statusCode: 1,
    serviceName: "fixture-agent",
    spanCount: 2,
    errorCount: 0,
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    costUsd: 0.000125,
    experimentName: null,
    experimentArm: null,
    ...overrides,
  };
}

function spanSummary(overrides: Partial<SpanSummary> = {}): SpanSummary {
  return {
    id: "00000000-0000-8000-8000-000000000123",
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "chat",
    kind: 3,
    spanClass: "llm_call",
    startedAt: new Date("2026-07-30T10:00:00.000Z"),
    durationMs: 250,
    statusCode: 1,
    serviceName: "fixture-agent",
    operationName: "chat",
    model: "gpt-5.5",
    toolName: null,
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    costUsd: 0.000125,
    experimentName: null,
    ...overrides,
  };
}

function otelSpan(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    id: "00000000-0000-8000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000001",
    receivedAt: new Date("2026-07-30T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    eventId: null,
    sourceId: null,
    parentSpanId: null,
    name: "chat",
    kind: 3,
    spanClass: "llm_call",
    startedAt: new Date("2026-07-30T10:00:00.125Z"),
    endedAt: new Date("2026-07-30T10:00:00.375Z"),
    durationMs: 250,
    statusCode: 1,
    serviceName: "fixture-agent",
    scopeName: "fixture",
    operationName: "chat",
    providerName: "openai",
    model: "gpt-5.5",
    inputTokens: 100,
    outputTokens: 25,
    cachedTokens: 10,
    reasoningTokens: 5,
    costUsd: "0.000125",
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: { "gen_ai.operation.name": "chat" },
    attrsTruncated: false,
    ...overrides,
  };
}

function pickFacets(value: object) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      [
        "services",
        "names",
        "statuses",
        "kinds",
        "environments",
        "models",
        "experiments",
        "arms",
        "minDurationMs",
        "maxDurationMs",
        "minTokens",
        "maxTokens",
        "minCostUsd",
        "maxCostUsd",
      ].includes(key),
    ),
  );
}

test("resolveTraceListView clamps month-preset starts at short month ends", () => {
  const fromMay31 = resolveTraceListView({ range: "3m" }, new Date("2026-05-31T12:00:00.000Z"));
  const fromLeapDay = resolveTraceListView({ range: "12m" }, new Date("2028-02-29T12:00:00.000Z"));

  assert.deepEqual(
    {
      threeMonths: [fromMay31.range.from, fromMay31.range.to],
      twelveMonths: [fromLeapDay.range.from, fromLeapDay.range.to],
    },
    {
      threeMonths: ["2026-03-01", "2026-05-31"],
      twelveMonths: ["2027-03-01", "2028-02-29"],
    },
  );
});

test("trace cursors are rejected when any filter-context field changes", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const current = resolveTraceListView(
    {
      project: "agent",
      range: "custom",
      from: "2026-07-01",
      to: "2026-07-15",
      rootName: "agent.run",
      name: "chat",
      model: "gpt-5.5",
      tool: "search_docs",
      errorOnly: "1",
      experiment: "ranking-v2",
      arm: "candidate",
    },
    now,
  );
  const token = serializeTraceCursor(
    {
      startedAt: new Date("2026-07-10T10:00:00.000Z"),
      traceId: "0123456789abcdef0123456789abcdef",
    },
    current.filters,
  );
  const drifted: Partial<typeof current.filters>[] = [
    { project: "other" },
    { range: "7d" },
    { from: "2026-07-02" },
    { to: "2026-07-16" },
    { rootName: "other.run" },
    { name: "execute_tool" },
    { model: "claude-sonnet-4-5" },
    { tool: "fetch_url" },
    { errorOnly: false },
    { experiment: "ranking-v3" },
    { arm: "control" },
  ];

  for (const change of drifted) {
    assert.equal(
      parseTraceCursor(token, { ...current.filters, ...change }),
      undefined,
      `cursor survived drifted ${Object.keys(change).join(",")}`,
    );
  }
  assert.notEqual(parseTraceCursor(token, current.filters), undefined);
});
