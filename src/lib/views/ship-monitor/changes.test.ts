import assert from "node:assert/strict";
import { test } from "node:test";
import { FIX_KINDS } from "@/lib/views/fixes/kinds";
import { toolChanges } from "./changes";

test("enrich: the first tool returns more, the second is no longer called", () => {
  assert.deepEqual(toolChanges("enrich", ["find_booking", "lookup_reservation"]), {
    changed: ["find_booking"],
    removed: ["lookup_reservation"],
  });
});

test("fold: the lookup folds into the main tool, so the main tool changes and the lookup goes", () => {
  assert.deepEqual(toolChanges("fold", ["get_e_ticket", "get_fare_rules"]), {
    changed: ["get_fare_rules"],
    removed: ["get_e_ticket"],
  });
});

test("merge and combine keep the first tool and replace the others", () => {
  assert.deepEqual(toolChanges("merge", ["get_seat_map", "select_seat"]), {
    changed: ["get_seat_map"],
    removed: ["select_seat"],
  });
  assert.deepEqual(toolChanges("combine", ["search_flights", "change_flight", "send_message"]), {
    changed: ["search_flights"],
    removed: ["change_flight", "send_message"],
  });
});

test("retire and preload take every tool out of the agent's calls", () => {
  assert.deepEqual(toolChanges("retire", ["old_tool"]), { changed: [], removed: ["old_tool"] });
  assert.deepEqual(toolChanges("preload", ["get_customer_profile"]), {
    changed: [],
    removed: ["get_customer_profile"],
  });
});

test("kinds that change a tool in place change every tool they name and remove none", () => {
  for (const kind of [
    "rewrite",
    "schema",
    "fail-clearly",
    "parallel",
    "split",
    "prerequisite",
    "tell-apart",
  ] as const) {
    assert.deepEqual(toolChanges(kind, ["a", "b"]), { changed: ["a", "b"], removed: [] }, kind);
  }
});

test("every fix kind has a mapping, and a fix with no tools watches nothing", () => {
  for (const kind of FIX_KINDS) {
    const { changed, removed } = toolChanges(kind, ["a", "b"]);
    assert.equal(
      new Set([...changed, ...removed]).size,
      changed.length + removed.length,
      `${kind} names a tool twice`,
    );
    assert.deepEqual(toolChanges(kind, []), { changed: [], removed: [] }, kind);
  }
});

test("a tool named twice is watched once", () => {
  assert.deepEqual(toolChanges("rewrite", ["a", "a"]), { changed: ["a"], removed: [] });
});
