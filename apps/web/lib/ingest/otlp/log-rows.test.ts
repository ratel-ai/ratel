import assert from "node:assert/strict";
import { test } from "node:test";
import { toOtelLogRows } from "./log-rows";
import type { DecodedLogRecord } from "./types";

function record(overrides: Partial<DecodedLogRecord> = {}): DecodedLogRecord {
  return {
    eventName: "ratel.experiment.comparison",
    timeUnixNano: "1750000000123456789",
    timeUnixMs: 1_750_000_000_123,
    observedTimeUnixNano: "1750000001123456789",
    observedTimeUnixMs: 1_750_000_001_123,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    severityNumber: 9,
    severityText: "INFO",
    body: { comparison: "shadow" },
    attributes: {
      "ratel.experiment.id": "search-ranking",
      "ratel.experiment.selection_id": "selection-1",
      "ratel.experiment.arm": "candidate",
      "ratel.experiment.role": "shadow",
      "ratel.experiment.agreement.jaccard_at_k": 0.5,
      "error.type": "ComparisonError",
      customer_email: "private@example.test",
    },
    catalogDefinition: null,
    resourceAttributes: { "service.name": "ranking-agent" },
    scopeName: "@ratel-ai/sdk",
    ...overrides,
  };
}

test("keeps ratel events, drops host logs, and maps the persisted row contract", () => {
  const result = toOtelLogRows("project-1", [
    record(),
    record({ eventName: "host.application.started" }),
  ]);

  assert.equal(result.dropped, 1);
  assert.equal(result.rows.length, 1);
  const [row] = result.rows;
  assert.equal(row.projectId, "project-1");
  assert.equal(row.eventName, "ratel.experiment.comparison");
  assert.equal(row.occurredAt.toISOString(), "2025-06-15T15:06:40.123Z");
  assert.equal(row.traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(row.spanId, "0123456789abcdef");
  assert.equal(row.severityNumber, 9);
  assert.equal(row.serviceName, "ranking-agent");
  assert.equal(row.scopeName, "@ratel-ai/sdk");
  assert.deepEqual(row.body, { comparison: "shadow" });
  assert.equal(row.experimentName, "search-ranking");
  assert.equal(row.experimentSelectionId, "selection-1");
  assert.equal(row.experimentArm, "candidate");
  assert.equal(row.experimentRole, "shadow");
  assert.deepEqual(row.experimentAttrs, {
    "ratel.experiment.id": "search-ranking",
    "ratel.experiment.selection_id": "selection-1",
    "ratel.experiment.arm": "candidate",
    "ratel.experiment.role": "shadow",
    "ratel.experiment.agreement.jaccard_at_k": 0.5,
  });
  assert.deepEqual(row.attributes, {
    "ratel.experiment.id": "search-ranking",
    "ratel.experiment.selection_id": "selection-1",
    "ratel.experiment.arm": "candidate",
    "ratel.experiment.role": "shadow",
    "ratel.experiment.agreement.jaccard_at_k": 0.5,
    "error.type": "ComparisonError",
  });
  assert.equal(row.attrsTruncated, false);
});

test("promotes selection identity for context-less outcomes and uses observed time", () => {
  const { rows, dropped } = toOtelLogRows("project-1", [
    record({
      eventName: "ratel.experiment.outcome",
      timeUnixNano: "",
      timeUnixMs: 0,
      observedTimeUnixNano: "1750000001123456789",
      observedTimeUnixMs: 1_750_000_001_123,
      traceId: null,
      spanId: null,
      attributes: {
        "ratel.experiment.id": "search-ranking",
        "ratel.experiment.selection_id": "selection-1",
        "ratel.experiment.outcome.label": "accepted",
        "ratel.experiment.outcome.score": 0.95,
      },
    }),
  ]);

  assert.equal(dropped, 0);
  assert.equal(rows[0].occurredAt.toISOString(), "2025-06-15T15:06:41.123Z");
  assert.equal(rows[0].traceId, null);
  assert.equal(rows[0].spanId, null);
  assert.equal(rows[0].experimentSelectionId, "selection-1");
  assert.equal(rows[0].experimentArm, null);
  assert.equal(rows[0].experimentRole, null);
});

test("promotes runtime event correlation and source identity", () => {
  const [row] = toOtelLogRows("project-1", [
    record({
      attributes: {
        "ratel.event.id": "evt-comparison",
        "ratel.experiment.id": "search-ranking",
      },
    }),
  ]).rows;

  assert.equal(row.eventId, "evt-comparison");
  assert.equal(row.sourceId, "ranking-agent");
  assert.equal(row.ingestSource, "otlp");
});

test("runtime catalog projection uses the OTLP record time for recency", () => {
  const catalogDefinition = {
    kind: "tool" as const,
    entryId: "read_file",
    name: "read_file",
    description: "Read files",
    tags: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    searchableDescription: "Read files",
    searchableDescriptionOverridden: false,
    useCloudDefinitions: false,
    contentHash: "a".repeat(64),
  };

  const [row] = toOtelLogRows("project-1", [
    record({
      eventName: "ratel.catalog.definition",
      catalogDefinition,
    }),
  ]).rows;

  assert.equal(row.catalogDefinition?.lastSeenAt?.toISOString(), "2025-06-15T15:06:40.123Z");
});

test("runtime catalog projection bounds free text and sanitizes JSON strings", () => {
  const oversized = `before\0${"😀".repeat(1_000)}`;
  const [row] = toOtelLogRows("project-1", [
    record({
      eventName: "ratel.catalog.definition",
      catalogDefinition: {
        kind: "tool",
        entryId: "read\0_file",
        name: "read\0_file",
        description: oversized,
        tags: ["file\0system"],
        inputSchema: { "ty\0pe": "object", note: "file\0 path" },
        outputSchema: { type: "str\0ing" },
        searchableDescription: oversized,
        searchableDescriptionOverridden: false,
        useCloudDefinitions: false,
        contentHash: oversized,
      },
    }),
  ]).rows;

  const definition = row.catalogDefinition;
  assert.ok(definition);
  assert.equal(definition.entryId, "read_file");
  assert.equal(definition.name, "read_file");
  assert.deepEqual(definition.tags, ["filesystem"]);
  assert.deepEqual(definition.inputSchema, {
    type: "object",
    note: "file path",
  });
  assert.deepEqual(definition.outputSchema, { type: "string" });
  for (const value of [
    definition.description,
    definition.searchableDescription,
    definition.contentHash,
  ]) {
    assert.ok(Buffer.byteLength(value, "utf8") <= 1_024);
    assert.equal(value.includes("\0"), false);
    assert.equal(value.endsWith("\uFFFD"), false);
  }
});

test("builds stable deterministic ids and distinguishes same-ms events", () => {
  const base = record();
  const reordered = record({
    attributes: Object.fromEntries(Object.entries(base.attributes).reverse()),
  });
  const sameMsDifferentNano = record({
    timeUnixNano: "1750000000123456790",
  });
  const changedAttributes = record({
    attributes: { ...base.attributes, "ratel.experiment.agreement.k": 10 },
  });

  const first = toOtelLogRows("project-1", [base]).rows[0];
  const retry = toOtelLogRows("project-1", [record()]).rows[0];
  const reorderedRow = toOtelLogRows("project-1", [reordered]).rows[0];
  const distinct = toOtelLogRows("project-1", [sameMsDifferentNano, changedAttributes]).rows;

  assert.equal(first.id, "42ed336a-72d0-8965-9668-c30c2a663ae0");
  assert.equal(retry.id, first.id);
  assert.equal(reorderedRow.id, first.id);
  assert.notEqual(distinct[0].id, first.id);
  assert.notEqual(distinct[1].id, first.id);
  assert.notEqual(distinct[0].id, distinct[1].id);
});

test("bounds retained and experiment attributes to 16 KiB", () => {
  const oversized = "😀".repeat(5_000);
  const { rows } = toOtelLogRows("project-1", [
    record({
      attributes: {
        "gen_ai.keep": "small",
        "gen_ai.oversized": oversized,
        "ratel.experiment.id": "search-ranking",
        "ratel.experiment.oversized": oversized,
        "ratel.experiment.keep_after_oversized": 42,
        "error.type": "ComparisonError",
      },
    }),
  ]);
  const [row] = rows;

  assert.ok(Buffer.byteLength(JSON.stringify(row.attributes), "utf8") <= 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(row.experimentAttrs), "utf8") <= 16 * 1024);
  assert.equal(row.attributes["gen_ai.keep"], "small");
  assert.equal(row.attributes["gen_ai.oversized"], undefined);
  assert.equal(row.attributes["ratel.experiment.keep_after_oversized"], 42);
  assert.equal(row.experimentAttrs["ratel.experiment.oversized"], undefined);
  assert.equal(row.experimentAttrs["ratel.experiment.keep_after_oversized"], 42);
  assert.equal(row.attrsTruncated, true);
});

test("bounds an oversized string body to 16 KiB without splitting a code point", () => {
  const oversized = "😀".repeat(10_000);
  const { rows } = toOtelLogRows("project-1", [record({ body: oversized })]);
  const [row] = rows;

  assert.equal(typeof row.body, "string");
  assert.ok(Buffer.byteLength(JSON.stringify(row.body), "utf8") <= 16 * 1024);
  assert.equal((row.body as string).endsWith("�"), false);
  assert.equal(row.attrsTruncated, true);
});

test("bounds an oversized structured body while preserving small ones", () => {
  const small = toOtelLogRows("project-1", [record({ body: { comparison: "shadow" } })]).rows[0];
  assert.deepEqual(small.body, { comparison: "shadow" });
  assert.equal(small.attrsTruncated, false);

  const big = toOtelLogRows("project-1", [record({ body: { note: "😀".repeat(10_000) } })]).rows[0];
  assert.ok(Buffer.byteLength(JSON.stringify(big.body), "utf8") <= 16 * 1024);
  assert.equal(big.attrsTruncated, true);
});

test("falls back from invalid event time to observed time, then current time", () => {
  const originalNow = Date.now;
  Date.now = () => 1_750_000_002_123;
  try {
    const { rows } = toOtelLogRows("project-1", [
      record({
        timeUnixMs: 8_640_000_000_000_001,
        observedTimeUnixMs: 1_750_000_001_123,
      }),
      record({
        timeUnixNano: "",
        timeUnixMs: 0,
        observedTimeUnixNano: "",
        observedTimeUnixMs: 0,
      }),
    ]);

    assert.equal(rows[0].occurredAt.toISOString(), "2025-06-15T15:06:41.123Z");
    assert.equal(rows[1].occurredAt.toISOString(), "2025-06-15T15:06:42.123Z");
  } finally {
    Date.now = originalNow;
  }
});

test("strips content-bearing and unapproved attributes from the generic map", () => {
  const { rows } = toOtelLogRows("project-1", [
    record({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system_instructions": "private system prompt",
        "gen_ai.input.messages": [{ role: "user", content: "private" }],
        "gen_ai.prompt.0.content": "legacy private prompt",
        "ratel.search.query": "private query",
        "ratel.experiment.id": "search-ranking",
        "ratel.experiment.result_attrs": [{ privateLabel: "private" }],
        "error.type": "ComparisonError",
        "server.address": "api.example.test",
        customer_email: "private@example.test",
      },
    }),
  ]);

  assert.deepEqual(rows[0].attributes, {
    "gen_ai.operation.name": "chat",
    "ratel.experiment.id": "search-ranking",
    "error.type": "ComparisonError",
    "server.address": "api.example.test",
  });
  assert.deepEqual(rows[0].experimentAttrs, {
    "ratel.experiment.id": "search-ranking",
    "ratel.experiment.result_attrs": [{ privateLabel: "private" }],
  });
});

test("bounds promoted metadata by UTF-8 bytes and defaults invalid severity", () => {
  const oversized = "😀".repeat(300);
  const { rows } = toOtelLogRows("project-1", [
    record({
      eventName: `ratel.${oversized}`,
      severityNumber: Number.POSITIVE_INFINITY,
      scopeName: oversized,
      resourceAttributes: { "service.name": oversized },
      attributes: {
        "ratel.experiment.id": oversized,
        "ratel.experiment.selection_id": oversized,
        "ratel.experiment.arm": oversized,
        "ratel.experiment.role": oversized,
      },
    }),
  ]);
  const [row] = rows;

  for (const value of [
    row.eventName,
    row.serviceName,
    row.scopeName,
    row.experimentName,
    row.experimentSelectionId,
    row.experimentArm,
    row.experimentRole,
  ]) {
    assert.ok(value != null);
    assert.ok(Buffer.byteLength(value, "utf8") <= 1_024);
    assert.equal(value.endsWith("\uFFFD"), false);
  }
  assert.equal(row.severityNumber, 0);
  assert.equal(row.attrsTruncated, true);
});
