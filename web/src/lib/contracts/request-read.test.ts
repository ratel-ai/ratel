import assert from "node:assert/strict";
import { test } from "node:test";
import { requestRead } from "./request-read";

test("inside a request it waits for Next's connection()", async () => {
  let waited = false;
  await requestRead(async () => {
    waited = true;
  });
  assert.equal(waited, true);
});

test("in a prerender it never resolves, so nothing after it is baked into the build", async () => {
  let resolved = false;
  void requestRead(() => new Promise<void>(() => {})).then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
});

test("outside Next (a test, a script) there is no prerender to stop: it resolves at once", async () => {
  await requestRead();
});

test("any other refusal (inside after(), inside a cache) still throws", async () => {
  const refusal = new Error("Route /x used `connection()` inside `after()` while rendering.");
  await assert.rejects(
    requestRead(() => {
      throw refusal;
    }),
    refusal,
  );
});
