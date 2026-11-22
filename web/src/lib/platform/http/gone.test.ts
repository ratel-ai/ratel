import assert from "node:assert/strict";
import { test } from "node:test";
import * as intents from "@/app/api/v1/intents/[[...path]]/route";
import * as queryIntents from "@/app/api/v1/query-intents/[[...path]]/route";
import * as suggestions from "@/app/api/v1/suggestions/[[...path]]/route";
import { INTENT_EXTRACTION_REMOVED_ON, removedEndpoint } from "@/lib/platform/http/gone";

const BODY = {
  error: "endpoint_removed",
  message: "This endpoint was removed on 2026-10-15.",
};

test("a removed endpoint answers 410 with the v1 error envelope", async () => {
  const handle = removedEndpoint(INTENT_EXTRACTION_REMOVED_ON);
  const res = await handle(
    new Request("https://cloud.test/api/v1/intents/analyze", { method: "POST" }),
  );
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), BODY);
});

const ROUTES = [
  { prefix: "/api/v1/intents", module: intents },
  { prefix: "/api/v1/query-intents", module: queryIntents },
  { prefix: "/api/v1/suggestions", module: suggestions },
] as const;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

test("every method on every removed prefix answers 410, at the root and below it", async () => {
  for (const { prefix, module } of ROUTES) {
    for (const method of METHODS) {
      for (const path of [prefix, `${prefix}/00000000-0000-4000-8000-000000000000/approve`]) {
        const res = await module[method](new Request(`https://cloud.test${path}`, { method }));
        assert.equal(res.status, 410, `${method} ${path}`);
        // withRequestLog stamps the request id, so its presence proves the wrap.
        assert.ok(res.headers.get("x-request-id"), `${method} ${path} is request-logged`);
        if (method !== "HEAD") assert.deepEqual(await res.json(), BODY, `${method} ${path}`);
      }
    }
  }
});
