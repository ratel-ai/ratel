import assert from "node:assert/strict";
import { test } from "node:test";
import { callMatches, parseSelector, SelectorError, selectorWindow } from "../domain/use-case";

/** RC-1124: a use case selector is checked once, in the domain. */

const refused = (input: unknown, code: SelectorError["code"]) =>
  assert.throws(
    () => parseSelector(input),
    (err: unknown) => err instanceof SelectorError && err.code === code,
    JSON.stringify(input),
  );

test("a selector with one task parses and drops duplicates and empty filters", () => {
  assert.deepEqual(
    parseSelector({
      taskIds: ["triage", "triage"],
      callFilter: { models: [], spanNames: ["chat"] },
    }),
    {
      taskIds: ["triage"],
      intentIds: [],
      callFilter: { spanNames: ["chat"] },
    },
  );
});

test("an unknown key, at the top or in the call filter, is refused as unknown_key", () => {
  refused({ taskIds: ["triage"], variant: "a" }, "unknown_key");
  refused({ taskIds: ["triage"], callFilter: { provider: ["anthropic"] } }, "unknown_key");
});

test("a selector with no task and no intent is refused as empty_selector", () => {
  refused({}, "empty_selector");
  refused(null, "empty_selector");
  refused({ taskIds: [], intentIds: [], callFilter: { models: ["m"] } }, "empty_selector");
});

test("a bad value is refused as invalid_selector", () => {
  refused({ intentIds: ["not-a-uuid"] }, "invalid_selector");
  refused(
    { taskIds: ["t"], dateRange: { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" } },
    "invalid_selector",
  );
  refused({ taskIds: "triage" }, "invalid_selector");
});

test("the window is the date range, else the last 30 days", () => {
  const now = new Date("2026-11-20T00:00:00.000Z");
  assert.deepEqual(selectorWindow({ taskIds: ["t"], intentIds: [] }, now), {
    since: new Date("2026-10-21T00:00:00.000Z"),
    until: now,
  });
  const range = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" };
  assert.deepEqual(selectorWindow({ taskIds: ["t"], intentIds: [], dateRange: range }, now), {
    since: new Date(range.from),
    until: new Date(range.to),
  });
});

test("the call filter keeps a call only when its model and its span name are listed", () => {
  const filter = { models: ["claude-haiku"], spanNames: ["chat classify"] };
  assert.equal(callMatches(filter, { model: "claude-haiku", spanName: "chat classify" }), true);
  assert.equal(callMatches(filter, { model: "claude-opus", spanName: "chat classify" }), false);
  assert.equal(callMatches(filter, { model: "claude-haiku", spanName: "chat summarize" }), false);
  assert.equal(callMatches(filter, { model: "claude-haiku", spanName: null }), false);
  assert.equal(callMatches(undefined, { model: null, spanName: null }), true);
});
