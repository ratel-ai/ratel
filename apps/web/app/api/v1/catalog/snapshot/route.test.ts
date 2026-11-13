import assert from "node:assert/strict";
import { test } from "node:test";
import { PUT } from "./route";

test("PUT is request-logged and rejects missing API-key auth", async () => {
  const response = await PUT(
    new Request("https://localhost/api/v1/catalog/snapshot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_id: "worker-a", tools: [] }),
    }),
  );

  assert.equal(response.status, 401);
  assert.ok(response.headers.get("x-request-id"));
});
