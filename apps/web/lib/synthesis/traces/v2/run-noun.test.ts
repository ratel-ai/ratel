import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_NOUN, runNoun, sessionPageTitle, TURN_NOUN, untitledTitle } from "./run-noun";

test("the views redesign calls a run a turn; without it a run stays a run", () => {
  assert.equal(runNoun(false), RUN_NOUN);
  assert.equal(runNoun(true), TURN_NOUN);
  assert.deepEqual(TURN_NOUN, { one: "Turn", many: "Turns", lower: "turn", lowerMany: "turns" });
  assert.deepEqual(RUN_NOUN, { one: "Run", many: "Runs", lower: "run", lowerMany: "runs" });
});

test("an untitled turn or session reads as its kind and a short id", () => {
  assert.equal(untitledTitle("turn", "35d8a7b7c0ffee00"), "Untitled turn · 35d8a7b7");
  assert.equal(untitledTitle("session", "sess-42"), "Untitled session · sess-42");
});

test("the session page is titled by its first ask, else as untitled; without the flag by its id", () => {
  assert.equal(
    sessionPageTitle("s-123456789", ["  Where is\n my order? ", "Thanks"], true),
    "Where is my order?",
  );
  assert.equal(sessionPageTitle("s-123456789", [null, "Later ask"], true), "Later ask");
  assert.equal(sessionPageTitle("s-123456789", [null], true), "Untitled session · s-123456");
  assert.equal(sessionPageTitle("s-123456789", ["Where is my order?"], false), "s-123456789");
});
