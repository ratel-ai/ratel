import assert from "node:assert/strict";
import { test } from "node:test";
import { trackBookmarks } from "@/lib/views/health/hallucinations/session-bookmarks";

const segments = [
  { stepIndex: 1, eventId: null, trackStartMs: 0 },
  { stepIndex: 2, eventId: "e-1", trackStartMs: 300 },
  { stepIndex: 3, eventId: "e-2", trackStartMs: 900 },
];

test("a session's hallucinations are bookmarked on the steps of their calls, the asked-for one marked", () => {
  const bookmarks = trackBookmarks(
    segments,
    [
      { eventId: "e-2", kind: "unknown_reference", toolId: "add_task_comment" },
      { eventId: "e-1", kind: "nope", toolId: "x" },
      { eventId: "gone", kind: "unknown_tool", toolId: "y" },
    ],
    "e-2",
  );
  assert.deepEqual(bookmarks, [
    {
      stepIndex: 3,
      label: "Referred to something that doesn't exist: add_task_comment",
      current: true,
    },
  ]);
});

test("two hallucinations on one call are one bookmark", () => {
  const bookmarks = trackBookmarks(
    segments,
    [
      { eventId: "e-1", kind: "unknown_reference", toolId: "a" },
      { eventId: "e-1", kind: "value_not_allowed", toolId: "a" },
    ],
    null,
  );
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0]?.current, false);
});
