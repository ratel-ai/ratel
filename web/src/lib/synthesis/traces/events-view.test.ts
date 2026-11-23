import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEventListHref,
  parseEventCursor,
  resolveEventListView,
  serializeEventCursor,
} from "./events-view";
import { parseTraceCursor, resolveTraceListView, serializeTraceCursor } from "./view";

test("resolveEventListView defaults to a seven-day UTC window and maps trimmed filters", () => {
  const view = resolveEventListView(
    {
      project: " agent ",
      eventName: " ratel.tool.call ",
      experiment: " ranking-v2 ",
      tracelessOnly: "true",
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
      eventName: "ratel.tool.call",
      experiment: "ranking-v2",
      tracelessOnly: true,
    },
    queryOptions: {
      since: new Date("2026-07-24T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
      eventName: "ratel.tool.call",
      experiment: "ranking-v2",
      tracelessOnly: true,
    },
  });
});

test("event cursors round-trip only within the normalized filter fingerprint", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const current = resolveEventListView(
    {
      project: "agent",
      range: "custom",
      from: "2026-07-01",
      to: "2026-07-15",
      eventName: "ratel.experiment.outcome",
      experiment: "ranking-v2",
      tracelessOnly: "1",
    },
    now,
  );
  const cursor = {
    occurredAt: new Date("2026-07-10T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
  };
  const token = serializeEventCursor(cursor, current.filters);

  assert.deepEqual(
    {
      parsed: parseEventCursor(token, current.filters),
      resolved: resolveEventListView(
        {
          project: "agent",
          range: "custom",
          from: "2026-07-01",
          to: "2026-07-15",
          eventName: "ratel.experiment.outcome",
          experiment: "ranking-v2",
          tracelessOnly: "1",
          cursor: token,
        },
        now,
      ).queryOptions.cursor,
      changedFilter: parseEventCursor(token, {
        ...current.filters,
        eventName: "ratel.experiment.results",
      }),
    },
    {
      parsed: cursor,
      resolved: cursor,
      changedFilter: undefined,
    },
  );
});

test("event cursor wire rejects malformed, noncanonical, and incompatible payloads", () => {
  const filters = resolveEventListView(
    { project: "agent", range: "7d" },
    new Date("2026-07-30T12:00:00.000Z"),
  ).filters;
  const cursor = {
    occurredAt: new Date("2026-07-29T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
  };
  const token = serializeEventCursor(cursor, filters);
  const wire = JSON.parse(token) as unknown[];

  assert.deepEqual(wire, [
    2,
    "2026-07-29T10:00:00.000Z",
    "00000000-0000-8000-8000-000000000123",
    "agent",
    "7d",
    "2026-07-24",
    "2026-07-30",
    "",
    "",
    0,
  ]);

  const rejected = [
    "not-json",
    JSON.stringify({ cursor: wire }),
    JSON.stringify([3, ...wire.slice(1)]),
    JSON.stringify(wire.slice(0, -1)),
    JSON.stringify([...wire, "extra"]),
    JSON.stringify([wire[0], "2026-07-29T10:00:00Z", ...wire.slice(2)]),
    JSON.stringify([wire[0], "not-a-date", ...wire.slice(2)]),
    JSON.stringify([...wire.slice(0, 2), "00000000000080008000000000000123", ...wire.slice(3)]),
  ];

  for (const invalid of rejected) {
    assert.equal(parseEventCursor(invalid, filters), undefined);
  }
  assert.throws(
    () => serializeEventCursor({ ...cursor, id: "00000000000080008000000000000123" }, filters),
    /Invalid event cursor/,
  );
});

test("trace and event cursor formats mutually reject each other", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const eventFilters = resolveEventListView({ project: "agent", range: "7d" }, now).filters;
  const traceFilters = resolveTraceListView({ project: "agent", range: "7d" }, now).filters;
  const eventToken = serializeEventCursor(
    {
      occurredAt: new Date("2026-07-29T10:00:00.000Z"),
      id: "00000000-0000-8000-8000-000000000123",
    },
    eventFilters,
  );
  const traceToken = serializeTraceCursor(
    {
      startedAt: new Date("2026-07-29T10:00:00.000Z"),
      traceId: "0123456789abcdef0123456789abcdef",
    },
    traceFilters,
  );

  assert.equal(parseTraceCursor(eventToken, traceFilters), undefined);
  assert.equal(parseEventCursor(traceToken, eventFilters), undefined);
});

test("event cursors are rejected when any filter-fingerprint field changes", () => {
  const current = resolveEventListView(
    {
      project: "agent",
      range: "custom",
      from: "2026-07-01",
      to: "2026-07-15",
      eventName: "ratel.experiment.outcome",
      experiment: "ranking-v2",
      tracelessOnly: "1",
    },
    new Date("2026-07-30T12:00:00.000Z"),
  );
  const token = serializeEventCursor(
    {
      occurredAt: new Date("2026-07-10T10:00:00.000Z"),
      id: "00000000-0000-8000-8000-000000000123",
    },
    current.filters,
  );
  const drifted: Partial<typeof current.filters>[] = [
    { project: "other" },
    { range: "7d" },
    { from: "2026-07-02" },
    { to: "2026-07-16" },
    { eventName: "ratel.experiment.results" },
    { experiment: "ranking-v3" },
    { tracelessOnly: false },
  ];

  for (const change of drifted) {
    assert.equal(
      parseEventCursor(token, { ...current.filters, ...change }),
      undefined,
      `cursor survived drifted ${Object.keys(change).join(",")}`,
    );
  }
  assert.notEqual(parseEventCursor(token, current.filters), undefined);
});

test("buildEventListHref preserves unrelated params, resets stale pagination, and binds next cursors", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const currentParams = {
    project: "agent",
    range: "7d",
    eventName: "ratel.experiment.outcome",
    experiment: "ranking-v2",
    tab: "all",
  };
  const current = resolveEventListView(currentParams, now);
  const cursor = {
    occurredAt: new Date("2026-07-29T10:00:00.000Z"),
    id: "00000000-0000-8000-8000-000000000123",
  };
  const paramsWithCursor = {
    ...currentParams,
    cursor: serializeEventCursor(cursor, current.filters),
  };

  const filtered = new URL(
    buildEventListHref(
      "/traces/events",
      paramsWithCursor,
      { eventName: "ratel.tool.call", tracelessOnly: true },
      now,
    ),
    "https://ratel.test",
  );
  const paginated = new URL(
    buildEventListHref("/traces/events", currentParams, { cursor }, now),
    "https://ratel.test",
  );

  assert.deepEqual(
    {
      filtered: Object.fromEntries(filtered.searchParams),
      paginatedCursor: resolveEventListView(Object.fromEntries(paginated.searchParams), now)
        .queryOptions.cursor,
    },
    {
      filtered: {
        project: "agent",
        range: "7d",
        eventName: "ratel.tool.call",
        experiment: "ranking-v2",
        tab: "all",
        tracelessOnly: "1",
      },
      paginatedCursor: cursor,
    },
  );
});

test("buildEventListHref clears filters and drops custom bounds on preset change", () => {
  const params = {
    project: "agent",
    range: "custom",
    from: "2026-07-01",
    to: "2026-07-15",
    eventName: "ratel.experiment.outcome",
    experiment: "ranking-v2",
    tracelessOnly: "1",
    cursor: "stale-token",
  };

  const cleared = buildEventListHref("/traces/events", params, {
    eventName: undefined,
    experiment: undefined,
    tracelessOnly: undefined,
    cursor: undefined,
  });
  const presetChanged = buildEventListHref("/traces/events", params, { range: "7d" });

  assert.equal(cleared, "/traces/events?project=agent&range=custom&from=2026-07-01&to=2026-07-15");
  assert.equal(
    presetChanged,
    "/traces/events?project=agent&range=7d&eventName=ratel.experiment.outcome&experiment=ranking-v2&tracelessOnly=1",
  );
});
