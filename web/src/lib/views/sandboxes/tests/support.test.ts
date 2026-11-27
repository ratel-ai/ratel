import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxDb } from "./support";

// Each open database holds ~100 MB of WASM memory. A file that opens one per test and keeps
// them all made the CI runner run out of memory (ratel #487 and #491, platform-test shards).
let opened: Awaited<ReturnType<typeof createSandboxDb>>["client"] | undefined;

test("a sandbox database opens for its test", async () => {
  const { client } = await createSandboxDb();
  opened = client;
  assert.equal(client.closed, false);
});

test("the database of the test before is closed", () => {
  assert.ok(opened);
  assert.equal(opened.closed, true);
});
