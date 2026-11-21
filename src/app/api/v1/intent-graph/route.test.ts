import assert from "node:assert/strict";
import { test } from "node:test";
import { GET, PUT } from "@/app/api/v1/intent-graph/route";

test("PUT is request-logged and rejects missing API-key auth", async () => {
  const response = await PUT(
    new Request("https://cloud.ratel.sh/api/v1/intent-graph", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_id: "worker-a",
        graph: { v: 1, built_from_ts: 0, intents: [] },
      }),
    }),
  );
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("x-request-id"));
});

test("GET is request-logged and rejects missing API-key auth", async () => {
  const response = await GET(
    new Request("https://cloud.ratel.sh/api/v1/intent-graph?source=worker-a"),
  );
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("x-request-id"));
});
