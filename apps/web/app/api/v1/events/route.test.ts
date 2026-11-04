import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "@/app/api/v1/events/route";

test("POST is request-logged and rejects missing API-key auth", async () => {
  const response = await POST(
    new Request("https://cloud.ratel.sh/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    }),
  );

  assert.equal(response.status, 401);
  assert.ok(response.headers.get("x-request-id"));
});
