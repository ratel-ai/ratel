import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolsCatalog } from "@/lib/synthesis/catalog/tools";

test("buildToolsCatalog unions definitions with exact calls and approximate metrics", () => {
  const rows = buildToolsCatalog(
    [
      {
        name: "weather.lookup",
        calls: 99,
        tokens: 80,
        costUsd: 0.4,
        lastSeenAt: new Date("2026-08-02T10:00:00.000Z"),
      },
    ],
    [
      {
        sourceId: "worker-a",
        sourceStatus: "fresh",
        sourceLastSeenAt: new Date("2026-08-03T10:00:00.000Z"),
        factsStartedAt: new Date("2026-08-02T00:00:00.000Z"),
        toolId: "weather.lookup",
        name: "weather.lookup",
        description: "Look up a forecast by city.",
        searchableDescription: null,
        inputSchema: null,
        outputSchema: null,
        metadata: null,
        calls: 3,
        errors: 0,
        lastUsedAt: new Date("2026-08-03T09:00:00.000Z"),
      },
      {
        sourceId: "worker-b",
        sourceStatus: "stale",
        sourceLastSeenAt: new Date("2026-08-01T10:00:00.000Z"),
        factsStartedAt: new Date("2026-08-01T00:00:00.000Z"),
        toolId: "calendar.create",
        name: "calendar.create",
        description: "Create a calendar event.",
        searchableDescription: null,
        inputSchema: null,
        outputSchema: null,
        metadata: null,
        calls: 0,
        errors: 0,
        lastUsedAt: null,
      },
    ],
  );

  assert.deepEqual(
    rows.map((row) => ({
      name: row.name,
      calls: row.calls,
      callsProvenance: row.callsProvenance,
      tokens: row.tokens,
      tokensProvenance: row.tokensProvenance,
      costUsd: row.costUsd,
      costProvenance: row.costProvenance,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      sources: row.sources.map((source) => ({
        id: source.sourceId,
        status: source.sourceStatus,
      })),
    })),
    [
      {
        name: "weather.lookup",
        calls: 3,
        callsProvenance: "facts",
        tokens: 80,
        tokensProvenance: "otel",
        costUsd: 0.4,
        costProvenance: "otel",
        lastSeenAt: "2026-08-03T09:00:00.000Z",
        sources: [{ id: "worker-a", status: "fresh" }],
      },
      {
        name: "calendar.create",
        calls: 0,
        callsProvenance: "facts",
        tokens: 0,
        tokensProvenance: "absent",
        costUsd: 0,
        costProvenance: "absent",
        lastSeenAt: null,
        sources: [{ id: "worker-b", status: "stale" }],
      },
    ],
  );
});

test("buildToolsCatalog keeps observed counts for a synced source whose facts era has not started", () => {
  const rows = buildToolsCatalog(
    [
      {
        name: "weather.lookup",
        calls: 99,
        tokens: 80,
        costUsd: 0.4,
        lastSeenAt: new Date("2026-08-02T10:00:00.000Z"),
      },
    ],
    [
      {
        sourceId: "worker-a",
        sourceStatus: "fresh",
        sourceLastSeenAt: new Date("2026-08-03T10:00:00.000Z"),
        factsStartedAt: null,
        toolId: "weather.lookup",
        name: "weather.lookup",
        description: "Look up a forecast by city.",
        searchableDescription: null,
        inputSchema: null,
        outputSchema: null,
        metadata: null,
        calls: 0,
        errors: 0,
        lastUsedAt: null,
      },
      {
        sourceId: "worker-a",
        sourceStatus: "fresh",
        sourceLastSeenAt: new Date("2026-08-03T10:00:00.000Z"),
        factsStartedAt: null,
        toolId: "calendar.create",
        name: "calendar.create",
        description: "Create a calendar event.",
        searchableDescription: null,
        inputSchema: null,
        outputSchema: null,
        metadata: null,
        calls: 0,
        errors: 0,
        lastUsedAt: null,
      },
    ],
  );

  assert.deepEqual(
    rows.map((row) => ({
      name: row.name,
      calls: row.calls,
      callsProvenance: row.callsProvenance,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      description: row.description,
    })),
    [
      {
        name: "weather.lookup",
        calls: 99,
        callsProvenance: "otel",
        lastSeenAt: "2026-08-02T10:00:00.000Z",
        description: "Look up a forecast by city.",
      },
      {
        name: "calendar.create",
        calls: 0,
        callsProvenance: "absent",
        lastSeenAt: null,
        description: "Create a calendar event.",
      },
    ],
  );
});

test("buildToolsCatalog keeps persistent definitions as non-fact fallbacks", () => {
  const rows = buildToolsCatalog(
    [],
    [],
    [
      {
        name: "calendar.create",
        description: "Create a calendar event.",
      },
    ],
  );

  assert.deepEqual(rows, [
    {
      name: "calendar.create",
      description: "Create a calendar event.",
      calls: 0,
      callsProvenance: "absent",
      tokens: 0,
      tokensProvenance: "absent",
      costUsd: 0,
      costProvenance: "absent",
      lastSeenAt: null,
      definition: {
        name: "calendar.create",
        description: "Create a calendar event.",
      },
      sources: [],
    },
  ]);
});
