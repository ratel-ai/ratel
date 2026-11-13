import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalogSnapshot } from "./snapshot";

test("catalog snapshot canonical hash ignores tool and object key order", () => {
  const first = parseCatalogSnapshot({
    source_id: "worker-a",
    tools: [
      {
        id: "weather.lookup",
        name: "weather.lookup",
        description: "Fetch a forecast.",
        input_schema: {
          required: ["city"],
          properties: { city: { type: "string" } },
          type: "object",
        },
      },
      { id: "calendar.create", name: "calendar.create", description: "Create an event." },
    ],
  });
  const reordered = parseCatalogSnapshot({
    sourceId: "worker-a",
    tools: [
      { description: "Create an event.", name: "calendar.create", id: "calendar.create" },
      {
        description: "Fetch a forecast.",
        name: "weather.lookup",
        id: "weather.lookup",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  });

  assert.equal(first.hash, reordered.hash);
  assert.match(first.etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(
    first.tools.map((tool) => tool.toolId),
    ["calendar.create", "weather.lookup"],
  );
});

test("a snapshot without a searchable description hashes exactly as it always has", () => {
  // Every publisher shipped before the field existed content-addresses its
  // catalog with this hash, and the ETag is what tells them a replay is
  // unchanged. Adding an always-present key to the canonical form would
  // invalidate all of them at once, so the key stays absent when unsupplied.
  const snapshot = parseCatalogSnapshot({
    source_id: "worker-a",
    tools: [{ id: "weather.lookup", name: "weather.lookup", description: "Fetch a forecast." }],
  });

  assert.equal(snapshot.hash, "6502509388f47a1c7fb2253379c464404aefe4f4aa9c864a5c4539914ed844a5");
  assert.equal(snapshot.tools[0].searchableDescription, undefined);
});

test("catalog snapshot accepts a searchable description under either alias", () => {
  const snake = parseCatalogSnapshot({
    source_id: "worker-a",
    tools: [
      {
        id: "add_task_comment",
        name: "add_task_comment",
        description: "Add a markdown comment to a task.",
        searchable_description: "comment note progress retro ping followup",
      },
    ],
  });
  const camel = parseCatalogSnapshot({
    sourceId: "worker-a",
    tools: [
      {
        id: "add_task_comment",
        name: "add_task_comment",
        description: "Add a markdown comment to a task.",
        searchableDescription: "comment note progress retro ping followup",
      },
    ],
  });

  assert.equal(snake.tools[0].searchableDescription, "comment note progress retro ping followup");
  assert.equal(snake.hash, camel.hash);
});

test("editing only the searchable description still produces a new catalog version", () => {
  // The retrieval text is the half of the pair the agent never sees, so a
  // publisher that rewrote only its keywords would look like an exact replay
  // and never be stored if the field sat outside the canonical form.
  const tool = {
    id: "get_daily_planning_context",
    name: "get_daily_planning_context",
    description: "Bundled daily planning data.",
  };
  const before = parseCatalogSnapshot({ source_id: "worker-a", tools: [tool] });
  const after = parseCatalogSnapshot({
    source_id: "worker-a",
    tools: [{ ...tool, searchable_description: "planning daily plan my day" }],
  });

  assert.notEqual(before.hash, after.hash);
});

test("catalog snapshot rejects conflicting searchable description aliases", () => {
  assert.throws(
    () =>
      parseCatalogSnapshot({
        source_id: "worker-a",
        tools: [
          {
            id: "weather",
            name: "weather",
            description: "Fetch a forecast.",
            searchable_description: "forecast",
            searchableDescription: "climate",
          },
        ],
      }),
    /searchable_description and searchableDescription must match/,
  );
});

test("catalog snapshot caps the searchable description like the description", () => {
  assert.throws(
    () =>
      parseCatalogSnapshot({
        source_id: "worker-a",
        tools: [
          {
            id: "weather",
            name: "weather",
            description: "Fetch a forecast.",
            searchable_description: "x".repeat(16_385),
          },
        ],
      }),
    /searchable_description exceeds 16384 characters/,
  );
});
