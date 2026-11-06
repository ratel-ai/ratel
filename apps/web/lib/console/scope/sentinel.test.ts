import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sentinelDestination } from "@/lib/console/scope/sentinel";

const COOKIE_PROJECT_ID = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const DB_PROJECT_ID = "b7654cd9-a761-4bb1-8606-cb107e4c8d22";
const USER_ID = "11111111-1111-4111-8111-111111111111";

test("underscore sentinel uses Next's routable escaped segment", async () => {
  const sentinelPage = fileURLToPath(
    // Owned (ADR-0030): the route lives under app/(console), one folder deeper from here.
    new URL("../../../app/(console)/project/%255F/[[...path]]/page.tsx", import.meta.url),
  );

  await access(sentinelPage);
});

test("sentinel resolves access while preserving subpath and query", async () => {
  assert.equal(
    await sentinelDestination(
      COOKIE_PROJECT_ID,
      ["traces", "trace 1"],
      {
        q: "search terms",
        tag: ["alpha", "beta"],
      },
      USER_ID,
      {
        getLastProjectId: async () => DB_PROJECT_ID,
        resolveProjectScope: async (projectId) =>
          projectId === DB_PROJECT_ID ? { projectId } : null,
      },
    ),
    `/project/${DB_PROJECT_ID}/traces/trace%201?q=search+terms&tag=alpha&tag=beta`,
  );
});

test("sentinel falls back to organizations without an accessible project", async () => {
  assert.equal(
    await sentinelDestination("not-a-project", ["traces"], { q: "ignored" }, USER_ID, {
      getLastProjectId: async () => DB_PROJECT_ID,
      resolveProjectScope: async () => null,
    }),
    "/organizations",
  );
});
