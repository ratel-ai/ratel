import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { stableErrorType } from "./error-type";

const headers = new Headers();

for (const [status, expected] of [
  [400, "bad_request"],
  [401, "unauthorized"],
  [402, "quota_exhausted"],
  [403, "access_denied"],
  [404, "not_found"],
  [408, "timeout"],
  [409, "client_error"],
  [422, "bad_request"],
  [429, "throttled"],
  [500, "server_error"],
  [503, "server_error"],
  [529, "server_error"],
] as const) {
  test(`an SDK error with status ${status} is ${expected}`, () => {
    assert.equal(
      stableErrorType(Anthropic.APIError.generate(status, { message: "x" }, "x", headers)),
      expected,
    );
  });
}

test("a class whose name the bundle mangled still maps by its status", () => {
  class h extends Error {
    readonly status = 503;
  }
  assert.equal(new h("Service unavailable").constructor.name, "h");
  assert.equal(stableErrorType(new h("Service unavailable")), "server_error");
});

test("a mangled class with nothing stable to read is unknown, never its name", () => {
  class h extends Error {}
  assert.equal(stableErrorType(new h("boom")), "unknown");
  assert.equal(stableErrorType(new Error("boom")), "unknown");
  assert.equal(stableErrorType("a thrown string"), "unknown");
});

test("no error has no type", () => {
  assert.equal(stableErrorType(undefined), undefined);
  assert.equal(stableErrorType(null), undefined);
});

test("connection failures are timeout or connection_error", () => {
  assert.equal(stableErrorType(new Anthropic.APIConnectionTimeoutError()), "timeout");
  assert.equal(
    stableErrorType(new Anthropic.APIConnectionError({ message: "socket hang up" })),
    "connection_error",
  );
  assert.equal(stableErrorType(new DOMException("timed out", "TimeoutError")), "timeout");
  assert.equal(stableErrorType(new DOMException("aborted", "AbortError")), "aborted");
  assert.equal(stableErrorType(new TypeError("fetch failed")), "connection_error");
});

test("an SDK error type is used when there is no status", () => {
  const err = Object.assign(new Error("overloaded"), { type: "overloaded_error" });
  assert.equal(stableErrorType(err), "overloaded_error");
});

test("an error's own errorType wins, when it is a word", () => {
  const notEnabled = Object.assign(
    new Anthropic.PermissionDeniedError(403, undefined, "x", headers),
    {
      errorType: "model_not_enabled",
    },
  );
  assert.equal(stableErrorType(notEnabled), "model_not_enabled");
  assert.equal(
    stableErrorType(Object.assign(new Error("x"), { errorType: "Not A Word" })),
    "unknown",
  );
});

test("a decision engine failure maps its reason to the shared words", () => {
  for (const [reason, expected] of [
    ["credentials", "unauthorized"],
    ["rate_limited", "throttled"],
    ["unavailable", "unavailable"],
    ["unreadable", "bad_response"],
    ["deadline", "timeout"],
    ["refused", "refused"],
  ] as const) {
    assert.equal(stableErrorType(Object.assign(new Error("x"), { reason })), expected, reason);
  }
});
