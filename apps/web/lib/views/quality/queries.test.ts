import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSightings } from "./queries";

const AT = new Date("2026-10-14T08:00:00.000Z");
const LATER = new Date("2026-10-14T09:30:00.000Z");

test("a search gets the trace of its own record, never of an id reused at another time", () => {
  const traces = matchSightings(
    [
      { selectionId: "search-1", occurredAt: AT },
      { selectionId: "4a2f6c1e-0000-4000-8000-000000000001", occurredAt: LATER },
      { selectionId: "search-2", occurredAt: AT },
    ],
    [
      // The same SDK search id, reused an hour and a half later in another session.
      { keys: ["search-1", "event-a"], occurredAt: LATER, traceId: "trace-of-another-run" },
      { keys: ["search-1", "event-b"], occurredAt: AT, traceId: "trace-1" },
      {
        keys: [null, "4a2f6c1e-0000-4000-8000-000000000001"],
        occurredAt: LATER,
        traceId: "trace-2",
      },
      { keys: ["search-2"], occurredAt: AT, traceId: null },
    ],
  );
  assert.equal(traces.get("search-1"), "trace-1");
  assert.equal(
    traces.get("4a2f6c1e-0000-4000-8000-000000000001"),
    "trace-2",
    "an event id matches its own record",
  );
  assert.equal(traces.has("search-2"), false, "a record without a trace links nowhere");
  assert.equal(
    matchSightings(
      [{ selectionId: "x", occurredAt: AT }],
      [{ keys: ["x"], occurredAt: null, traceId: "t" }],
    ).size,
    0,
  );
});
