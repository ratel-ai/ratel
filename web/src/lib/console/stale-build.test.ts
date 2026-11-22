import assert from "node:assert/strict";
import { test } from "node:test";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { isStaleBuildError, STALE_BUILD_MESSAGE } from "@/lib/console/stale-build";

test("a server action the server does not know is a stale build", () => {
  assert.equal(
    isStaleBuildError(
      new UnrecognizedActionError('Server Action "00271ec1" was not found on the server.'),
    ),
    true,
  );
});

test("other failures are not a stale build", () => {
  for (const error of [
    new Error("boom"),
    new TypeError("Failed to fetch"),
    undefined,
    null,
    "Server Action not found",
  ]) {
    assert.equal(isStaleBuildError(error), false, String(error));
  }
});

test("the stale build message tells the user to reload", () => {
  assert.equal(STALE_BUILD_MESSAGE, "A new version of Ratel is available. Reload the page.");
});
