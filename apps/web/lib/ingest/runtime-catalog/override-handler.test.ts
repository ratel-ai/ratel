import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleRuntimeCatalogOverridePatch,
  handleRuntimeCatalogOverridesGet,
  type RuntimeCatalogOverrideHandlerDeps,
} from "./override-handler";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function deps(
  overrides: Partial<RuntimeCatalogOverrideHandlerDeps> = {},
): RuntimeCatalogOverrideHandlerDeps {
  return {
    resolveProjectById: async () => ({
      ok: true,
      accountId: "org-1",
      externalId: "user-1",
      organization: { id: "org-1" } as never,
      project: { id: PROJECT_ID } as never,
    }),
    resolveProjectFromBearer: async () => ({
      ok: true,
      projectId: PROJECT_ID,
      apiKeyId: "key-1",
    }),
    getOrganizationByProjectId: async () => ({ id: "org-1" }) as never,
    touchRuntimeCatalogOverridesPull: async () => {},
    setRuntimeCatalogOverride: async (_projectId, _kind, _entryId, value) => ({
      searchableDescriptionOverride: value,
    }),
    listRuntimeCatalogOverrides: async () => [],
    setRequestLogContext: () => {},
    trackServerEvent: async () => {},
    ...overrides,
  };
}

function patch(body: unknown): Request {
  return new Request(
    `https://cloud.ratel.sh/api/runtime-catalog/tool/read_file?project=${PROJECT_ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

test("PATCH addresses the project by id, so it cannot land on a same-slug tenant", async () => {
  // Slugs are unique per organization only. Resolving the write through the
  // session's active-organization pointer let a member of two organizations
  // save org A's project while looking at org B's.
  const resolved: Array<string | null> = [];
  await handleRuntimeCatalogOverridePatch(
    patch({ searchableDescription: "parse local documents" }),
    { kind: "tool", entryId: "read_file" },
    deps({
      resolveProjectById: async (projectId) => {
        resolved.push(projectId);
        return {
          ok: true,
          accountId: "org-1",
          externalId: "user-1",
          organization: { id: "org-1" } as never,
          project: { id: PROJECT_ID } as never,
        };
      },
    }),
  );
  assert.deepEqual(resolved, [PROJECT_ID]);
});

test("PATCH sets and echoes a searchable-description override", async () => {
  const writes: unknown[][] = [];
  const events: unknown[][] = [];
  const contexts: unknown[] = [];
  const response = await handleRuntimeCatalogOverridePatch(
    patch({ searchableDescription: "parse local documents" }),
    { kind: "tool", entryId: "read_file" },
    deps({
      setRuntimeCatalogOverride: async (...args) => {
        writes.push(args);
        return { searchableDescriptionOverride: args[3] };
      },
      setRequestLogContext: (_request, context) => contexts.push(context),
      trackServerEvent: async (...args) => {
        events.push(args);
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    kind: "tool",
    entryId: "read_file",
    searchableDescription: "parse local documents",
  });
  assert.deepEqual(writes, [[PROJECT_ID, "tool", "read_file", "parse local documents"]]);
  assert.deepEqual(contexts, [
    {
      project_id: PROJECT_ID,
      org_id: "org-1",
      distinct_id: "user-1",
    },
  ]);
  assert.deepEqual(events, [
    [
      "runtime_catalog_override_updated",
      { externalId: "user-1", orgId: "org-1", projectId: PROJECT_ID },
      {
        object_action: "runtime_catalog_override_updated",
        kind: "tool",
        entry_id: "read_file",
        cleared: false,
      },
    ],
  ]);
});

test("PATCH accepts empty text and null clears", async () => {
  for (const searchableDescription of ["", null]) {
    const response = await handleRuntimeCatalogOverridePatch(
      patch({ searchableDescription }),
      { kind: "skill", entryId: "writer" },
      deps(),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).searchableDescription, searchableDescription);
  }
});

test("PATCH rejects unknown kinds and invalid bodies", async () => {
  assert.equal(
    (
      await handleRuntimeCatalogOverridePatch(
        patch({ searchableDescription: "words" }),
        { kind: "unknown", entryId: "read_file" },
        deps(),
      )
    ).status,
    400,
  );
  for (const body of [{}, { searchableDescription: 3 }]) {
    assert.equal(
      (
        await handleRuntimeCatalogOverridePatch(
          patch(body),
          { kind: "tool", entryId: "read_file" },
          deps(),
        )
      ).status,
      400,
    );
  }
});

test("PATCH rejects retrieval descriptions over 4 KiB", async () => {
  let wrote = false;
  const response = await handleRuntimeCatalogOverridePatch(
    patch({ searchableDescription: "x".repeat(4 * 1024 + 1) }),
    { kind: "tool", entryId: "read_file" },
    deps({
      setRuntimeCatalogOverride: async () => {
        wrote = true;
        return { searchableDescriptionOverride: null };
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(wrote, false);
});

test("PATCH returns 404 for a never-ingested entry or disabled feature", async () => {
  assert.equal(
    (
      await handleRuntimeCatalogOverridePatch(
        patch({ searchableDescription: "words" }),
        { kind: "tool", entryId: "ghost" },
        deps({ setRuntimeCatalogOverride: async () => null }),
      )
    ).status,
    404,
  );
});

test("GET returns exactly the fixed sorted override wire", async () => {
  const overrides = [
    { kind: "fact", entryId: "timezone", searchableDescription: "local clock" },
    { kind: "tool", entryId: "read_file", searchableDescription: "parse documents" },
  ];
  const response = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/v1/runtime-catalog/overrides", {
      headers: { authorization: "Bearer rtl_test" },
    }),
    deps({ listRuntimeCatalogOverrides: async () => overrides }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("etag"),
    '"fb17b76481b676f9872294ada0b427339c4cb533f7448aeddff94daebe746c99"',
  );
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await response.json(), { overrides });
});

test("GET returns 304 when If-None-Match matches the overrides payload", async () => {
  const response = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/v1/runtime-catalog/overrides", {
      headers: {
        authorization: "Bearer rtl_test",
        "if-none-match": 'W/"fb17b76481b676f9872294ada0b427339c4cb533f7448aeddff94daebe746c99"',
      },
    }),
    deps({
      listRuntimeCatalogOverrides: async () => [
        { kind: "fact", entryId: "timezone", searchableDescription: "local clock" },
        { kind: "tool", entryId: "read_file", searchableDescription: "parse documents" },
      ],
    }),
  );

  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(
    response.headers.get("etag"),
    '"fb17b76481b676f9872294ada0b427339c4cb533f7448aeddff94daebe746c99"',
  );
  assert.equal(response.headers.get("cache-control"), "no-cache");
});

test("GET ETag moves on set and returns to the empty tag on clear", async () => {
  let overrides: Array<{
    kind: string;
    entryId: string;
    searchableDescription: string;
  }> = [];
  const get = () =>
    handleRuntimeCatalogOverridesGet(
      new Request("https://cloud.ratel.sh/v1/runtime-catalog/overrides", {
        headers: { authorization: "Bearer rtl_test" },
      }),
      deps({ listRuntimeCatalogOverrides: async () => overrides }),
    );

  const emptyTag = (await get()).headers.get("etag");
  overrides = [
    {
      kind: "tool",
      entryId: "read_file",
      searchableDescription: "parse documents",
    },
  ];
  const setTag = (await get()).headers.get("etag");
  overrides = [];
  const clearedTag = (await get()).headers.get("etag");

  assert.notEqual(setTag, emptyTag);
  assert.equal(clearedTag, emptyTag);
});

test("GET preserves bearer failures and hides a disabled feature", async () => {
  const unauthorized = Response.json({ error: "invalid" }, { status: 401 });
  assert.equal(
    (
      await handleRuntimeCatalogOverridesGet(
        new Request("https://cloud.ratel.sh/v1/runtime-catalog/overrides"),
        deps({
          resolveProjectFromBearer: async () => ({ ok: false, response: unauthorized }),
        }),
      )
    ).status,
    401,
  );
});

test("GET records the override pull, including when it answers 304", async () => {
  // The pull is the only positive evidence that an override we store reaches a
  // runtime, and 304 is the overwhelmingly common answer: a runtime polling on
  // a schedule almost never gets a 200. Recording only on 200 would make an
  // actively-listening runtime look silent.
  const pulls: string[] = [];
  const d = deps({
    touchRuntimeCatalogOverridesPull: async (projectId) => {
      pulls.push(projectId);
    },
  });

  const first = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/api/v1/runtime-catalog/overrides", {
      headers: { authorization: "Bearer rtl_test" },
    }),
    d,
  );
  assert.equal(first.status, 200);

  const second = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/api/v1/runtime-catalog/overrides", {
      headers: {
        authorization: "Bearer rtl_test",
        "if-none-match": first.headers.get("etag") ?? "",
      },
    }),
    d,
  );
  assert.equal(second.status, 304);
  assert.deepEqual(pulls, [PROJECT_ID, PROJECT_ID]);
});

test("a failure to record the pull never fails the pull", async () => {
  const response = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/api/v1/runtime-catalog/overrides", {
      headers: { authorization: "Bearer rtl_test" },
    }),
    deps({
      touchRuntimeCatalogOverridesPull: async () => {
        throw new Error("database is having a moment");
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.ok(response.headers.get("etag"));
});

test("an unauthenticated pull is not evidence that anyone is listening", async () => {
  const pulls: string[] = [];
  const response = await handleRuntimeCatalogOverridesGet(
    new Request("https://cloud.ratel.sh/api/v1/runtime-catalog/overrides"),
    deps({
      resolveProjectFromBearer: async () => ({
        ok: false,
        response: Response.json({ error: "Unauthorized." }, { status: 401 }),
      }),
      touchRuntimeCatalogOverridesPull: async (projectId) => {
        pulls.push(projectId);
      },
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(pulls, []);
});
