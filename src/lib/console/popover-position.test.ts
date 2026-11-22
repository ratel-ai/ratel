import assert from "node:assert/strict";
import { test } from "node:test";
import { placePopover } from "@/lib/console/popover-position";

test("popover placement shifts an end-aligned panel inside the viewport", () => {
  assert.deepEqual(
    placePopover({
      anchor: { left: 1360, right: 1440, top: 80, bottom: 116 },
      popover: { width: 320, height: 600 },
      viewport: { width: 1440, height: 900 },
      align: "end",
    }),
    { left: 1108, top: 124, maxHeight: 876, placement: "below" },
  );
});

test("popover placement flips above a trigger near the viewport bottom", () => {
  assert.deepEqual(
    placePopover({
      anchor: { left: 800, right: 900, top: 840, bottom: 876 },
      popover: { width: 320, height: 600 },
      viewport: { width: 1440, height: 900 },
      align: "start",
    }),
    { left: 800, top: 232, maxHeight: 876, placement: "above" },
  );
});

test("popover placement constrains a panel taller than the viewport", () => {
  assert.deepEqual(
    placePopover({
      anchor: { left: 8, right: 108, top: 300, bottom: 336 },
      popover: { width: 500, height: 1_000 },
      viewport: { width: 375, height: 640 },
      align: "start",
    }),
    { left: 12, top: 12, maxHeight: 616, placement: "below" },
  );
});
