import assert from "node:assert/strict";
import { test } from "node:test";
import { isOutage, storeFailure } from "./store-failure";

const withCode = (code: string) =>
  new Error("Failed query", { cause: Object.assign(new Error("detail"), { code }) });

test("a server that cannot be reached or refuses all work is an outage", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "08006", "53300", "57P01", "57P03", "25006"]) {
    assert.equal(isOutage(withCode(code)), true, code);
  }
  for (const message of [
    "Connection terminated unexpectedly",
    "timeout exceeded when trying to connect",
  ]) {
    assert.equal(isOutage(new Error("Failed query", { cause: new Error(message) })), true, message);
  }
});

test("a failure of one message is a retry", () => {
  for (const code of ["23503", "40001", "57014", "22P05"]) {
    assert.equal(isOutage(withCode(code)), false, code);
  }
  assert.deepEqual(storeFailure(new TypeError("prompt text")), {
    outcome: "retry",
    reason: "uncaught TypeError",
  });
  assert.equal(storeFailure(undefined).outcome, "retry");
});
