import assert from "node:assert/strict";
import { test } from "node:test";
import { McpOperationError } from "./errors";
import { DAY_MS, resolveWindow, WINDOW_PRESETS } from "./windows";

const NOW = new Date("2026-08-25T12:00:00.000Z");

test("an omitted window falls back to the preset default", () => {
  const window = resolveWindow({}, WINDOW_PRESETS.aggregates, NOW);

  assert.equal(window.until.toISOString(), NOW.toISOString());
  assert.equal(window.since.toISOString(), new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
  assert.equal(window.clamped, false);
});

test("an over-wide window is clamped and says so, rather than being refused", () => {
  const window = resolveWindow({ since: "2020-01-01T00:00:00.000Z" }, WINDOW_PRESETS.traces, NOW);

  assert.equal(window.clamped, true);
  assert.equal(window.since.toISOString(), new Date(NOW.getTime() - 30 * DAY_MS).toISOString());
});

test("a window inside the ceiling is preserved exactly", () => {
  const since = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();
  const window = resolveWindow({ since }, WINDOW_PRESETS.traces, NOW);

  assert.equal(window.clamped, false);
  assert.equal(window.since.toISOString(), since);
});

test("an inverted range is rejected", () => {
  assert.throws(
    () =>
      resolveWindow(
        { since: "2026-08-25T12:00:00.000Z", until: "2026-08-01T00:00:00.000Z" },
        WINDOW_PRESETS.aggregates,
        NOW,
      ),
    (error: unknown) => {
      assert.ok(error instanceof McpOperationError);
      assert.equal(error.code, "invalid_params");
      return true;
    },
  );
});

test("toJSON emits the window actually queried", () => {
  const window = resolveWindow({}, WINDOW_PRESETS.traces, NOW);

  assert.deepEqual(window.toJSON(), {
    since: new Date(NOW.getTime() - DAY_MS).toISOString(),
    until: NOW.toISOString(),
  });
});
