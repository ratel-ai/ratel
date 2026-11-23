import assert from "node:assert/strict";
import { test } from "node:test";
import { keepFailureFields } from "@/lib/platform/api-key-secrets";

test("a failed keep logs the error's name and database code, never its message", () => {
  const failed = new Error(
    'Failed query: insert into "api_key_secrets" params: key-1,c2VhbGVk,bm9uY2U=',
    {
      cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
    },
  );
  const fields = keepFailureFields(failed);
  assert.deepEqual(fields, { error: "Error", code: "23505" });
  assert.ok(!JSON.stringify(fields).includes("c2VhbGVk"), "the sealed key stays out of the log");
});

test("a failure with no code logs its name only", () => {
  assert.deepEqual(keepFailureFields(new TypeError("boom")), { error: "TypeError" });
  assert.deepEqual(keepFailureFields("boom"), { error: "unknown" });
});
