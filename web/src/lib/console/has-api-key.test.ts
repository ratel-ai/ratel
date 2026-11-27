import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUsableApiKey } from "@/lib/console/has-api-key";

const QUIET = { logError: () => {}, reportServerException: () => {} };

test("a project whose primary key exists has a usable key", async () => {
  assert.equal(await hasUsableApiKey("p1", async () => ({ id: "k1" })), true);
});

test("no usable key (none, or only revoked or expired ones) is no key", async () => {
  assert.equal(await hasUsableApiKey("p1", async () => null), false);
});

test("a failed read is no key: the CTA asks to create one, as before", async () => {
  const down = async () => {
    throw new Error("database down");
  };
  assert.equal(await hasUsableApiKey("p1", down, QUIET), false);
});

test("the read is for the project asked about", async () => {
  const asked: string[] = [];
  await hasUsableApiKey("p 1", async (projectId) => {
    asked.push(projectId);
    return null;
  });
  assert.deepEqual(asked, ["p 1"]);
});
