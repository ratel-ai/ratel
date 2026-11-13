import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeEventsView, runtimeEventsHref } from "@/lib/ingest/runtime-events/view";

const NOW = new Date("2026-08-13T12:00:00.000Z");

test("runtime events view validates filters and resolves an exact time window", () => {
  const view = resolveRuntimeEventsView(
    {
      tab: "dropped",
      range: "24h",
      type: " search ",
      source: "worker-1",
      event: "evt-1",
    },
    NOW,
  );

  assert.equal(view.tab, "dropped");
  assert.equal(view.range, "24h");
  assert.equal(view.since.toISOString(), "2026-08-12T12:00:00.000Z");
  assert.equal(view.until.toISOString(), NOW.toISOString());
  assert.equal(view.type, "search");
  assert.equal(view.sourceId, "worker-1");
  assert.equal(view.selectedEventId, "evt-1");
});

test("runtime events links preserve filters and discard event selection between tabs", () => {
  const view = resolveRuntimeEventsView({ range: "30d", type: "search", source: "worker-1" }, NOW);

  assert.equal(
    runtimeEventsHref("/project/p/runtime-events", view, { tab: "dropped" }),
    "/project/p/runtime-events?tab=dropped&range=30d&type=search&source=worker-1",
  );
  assert.equal(
    runtimeEventsHref("/project/p/runtime-events", view, { event: "evt-1" }),
    "/project/p/runtime-events?range=30d&type=search&source=worker-1&event=evt-1",
  );
});
