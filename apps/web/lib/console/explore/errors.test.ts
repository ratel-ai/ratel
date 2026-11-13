import assert from "node:assert/strict";
import { test } from "node:test";
import { explainMutationError } from "./errors";

test("explainMutationError maps each documented reason", () => {
  assert.match(explainMutationError(404, "not_found"), /no longer exists/i);
  assert.match(explainMutationError(409, "name_conflict"), /already exists/i);
  assert.match(explainMutationError(409, "version_conflict"), /changed since you opened it/i);
});

test("explainMutationError falls back by status when there is no reason", () => {
  assert.match(explainMutationError(401), /session expired/i);
  assert.match(explainMutationError(404), /not found/i);
  assert.match(explainMutationError(0), /network error/i);
  assert.match(explainMutationError(500), /something went wrong/i);
});

test("a known reason wins over the status fallback", () => {
  assert.match(explainMutationError(409, "name_conflict"), /already exists/i);
});
