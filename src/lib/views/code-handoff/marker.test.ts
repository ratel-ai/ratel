import assert from "node:assert/strict";
import { test } from "node:test";
import { fixMarker, parseFixMarkers } from "./marker";

const A = "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const B = "rewrite:5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";

test("fixMarker writes the marker line", () => {
  assert.equal(fixMarker(A), `ratel-fix: ${A}`);
});

test("parseFixMarkers finds every marker, in order, once each", () => {
  const text = `Fix the tool description\n\n${fixMarker(A)}\nratel-fix:${B}\nagain ${fixMarker(A)}`;
  assert.deepEqual(parseFixMarkers(text), [A, B]);
});

test("parseFixMarkers reads the marker back from what fixMarker writes, for every source", () => {
  for (const id of [A, B, "issue:11111111-2222-4333-8444-555555555555"]) {
    assert.deepEqual(parseFixMarkers(fixMarker(id)), [id]);
  }
});

test("parseFixMarkers ignores malformed ids", () => {
  const text = [
    "ratel-fix: craft:not-a-uuid",
    "ratel-fix: unknown:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e",
    "ratel-fix: intent:billing-questions",
    "ratel-fix: craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8",
    "ratel-fix: craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e0",
    "ratel-fix:",
    "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e",
  ].join("\n");
  assert.deepEqual(parseFixMarkers(text), []);
});

test("parseFixMarkers lowercases an uppercase uuid", () => {
  assert.deepEqual(parseFixMarkers(`Ratel-Fix: ${A.toUpperCase()}`), [A]);
});
