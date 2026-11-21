import assert from "node:assert/strict";
import { test } from "node:test";
import { updateRuntimeCatalogOverride } from "./override-client";

// A uuid, not a slug: slugs are unique per organization, so a slug-addressed
// save could resolve to a different tenant’s same-slug project.
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("client PATCHes the encoded dashboard route and returns its echo", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const result = await updateRuntimeCatalogOverride(
    async (input, init) => {
      calls.push([String(input), init]);
      return Response.json({
        kind: "tool",
        entryId: "read/file",
        searchableDescription: "parse docs",
      });
    },
    {
      projectId: PROJECT_ID,
      kind: "tool",
      entryId: "read/file",
      searchableDescription: "parse docs",
    },
  );

  assert.deepEqual(result, { ok: true, searchableDescription: "parse docs" });
  assert.equal(calls[0]?.[0], `/api/runtime-catalog/tool/read%2Ffile?project=${PROJECT_ID}`);
  assert.equal(calls[0]?.[1]?.method, "PATCH");
  assert.equal(calls[0]?.[1]?.body, JSON.stringify({ searchableDescription: "parse docs" }));
});

test("client sends null to clear and surfaces server errors", async () => {
  const cleared = await updateRuntimeCatalogOverride(
    async (_input, init) => {
      assert.equal(init?.body, JSON.stringify({ searchableDescription: null }));
      return Response.json({ searchableDescription: null });
    },
    {
      projectId: PROJECT_ID,
      kind: "fact",
      entryId: "timezone",
      searchableDescription: null,
    },
  );
  assert.deepEqual(cleared, { ok: true, searchableDescription: null });

  const failed = await updateRuntimeCatalogOverride(
    async () => Response.json({ error: "Entry disappeared." }, { status: 404 }),
    {
      projectId: PROJECT_ID,
      kind: "tool",
      entryId: "ghost",
      searchableDescription: "words",
    },
  );
  assert.deepEqual(failed, { ok: false, error: "Entry disappeared." });
});
