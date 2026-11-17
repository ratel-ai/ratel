import assert from "node:assert/strict";
import { test } from "node:test";
import { runsListPath, sessionPageTitle, TURN_NOUN, untitledTitle } from "./run-noun";

test("the trace and session views call a run a turn", () => {
  assert.deepEqual(TURN_NOUN, { one: "Turn", many: "Turns", lower: "turn", lowerMany: "turns" });
});

test("an untitled turn or session reads as its kind and a short id", () => {
  assert.equal(untitledTitle("turn", "35d8a7b7c0ffee00"), "Untitled turn · 35d8a7b7");
  assert.equal(untitledTitle("session", "sess-42"), "Untitled session · sess-42");
});

test("the session page is titled by its first ask, else as untitled", () => {
  assert.equal(
    sessionPageTitle("s-123456789", ["  Where is\n my order? ", "Thanks"]),
    "Where is my order?",
  );
  assert.equal(sessionPageTitle("s-123456789", [null, "Later ask"]), "Later ask");
  assert.equal(sessionPageTitle("s-123456789", [null]), "Untitled session · s-123456");
});

test("a trace links back to the Turns tab, since Traces opens on Sessions", () => {
  assert.equal(runsListPath("/project/p/traces"), "/project/p/traces/turns");
});
