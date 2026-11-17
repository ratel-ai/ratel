import assert from "node:assert/strict";
import { test } from "node:test";
import { generateApiKey, PUBLISHABLE_KEY_PREFIX } from "@/lib/platform/api-keys";
import {
  ALL_SCOPES,
  API_KEY_SCOPE_INFO,
  API_KEY_SCOPES,
  apiKeyAccess,
  hasScope,
  INGEST_SCOPES,
  isPublishableScopes,
  missingScopeMessage,
  presetScopes,
  READ_ONLY_SCOPES,
  resolveScopeChoice,
} from "@/lib/platform/api-keys/scopes";

test("a Full key ('*') holds every scope, including ones added later", () => {
  for (const scope of API_KEY_SCOPES) assert.ok(hasScope([ALL_SCOPES], scope), scope);
});

test("a narrow key holds only what it lists, and unknown stored values grant nothing", () => {
  assert.ok(hasScope(["catalog:read"], "catalog:read"));
  assert.ok(!hasScope(["catalog:read"], "catalog:write"));
  assert.ok(!hasScope(["catalog:*"], "catalog:read"));
  assert.ok(!hasScope([], "ingest:traces"));
});

test("the ingest preset is the three ingest scopes and nothing that reads or changes anything", () => {
  assert.deepEqual([...presetScopes("ingest")], ["ingest:traces", "ingest:logs", "ingest:events"]);
  for (const scope of API_KEY_SCOPES) {
    assert.equal(
      hasScope(presetScopes("ingest") as string[], scope),
      scope.startsWith("ingest:"),
      scope,
    );
  }
});

test("read-only reads but never writes, spends credit, or reads captured content", () => {
  for (const scope of READ_ONLY_SCOPES) assert.match(scope, /:read$/);
  for (const forbidden of ["content:read", "embeddings", "tool_picker", "mcp:write"] as const) {
    assert.ok(!READ_ONLY_SCOPES.includes(forbidden), forbidden);
  }
});

test("only a key whose every scope is an ingest scope is publishable", () => {
  assert.ok(isPublishableScopes([...INGEST_SCOPES]));
  assert.ok(isPublishableScopes(["ingest:logs"]));
  assert.ok(!isPublishableScopes([]));
  assert.ok(!isPublishableScopes([ALL_SCOPES]));
  assert.ok(!isPublishableScopes(["ingest:traces", "catalog:read"]));
});

test("a stored list reads back as its preset, in any order, or as custom", () => {
  assert.equal(apiKeyAccess([ALL_SCOPES]), "full");
  assert.equal(apiKeyAccess(["ingest:events", "ingest:traces", "ingest:logs"]), "ingest");
  assert.equal(apiKeyAccess([...READ_ONLY_SCOPES].reverse()), "read_only");
  assert.equal(apiKeyAccess(["ingest:traces"]), "custom");
});

test("the create form's choice resolves to what is stored, and anything odd is refused", () => {
  assert.deepEqual(resolveScopeChoice({}), { ok: true, scopes: [ALL_SCOPES] });
  assert.deepEqual(resolveScopeChoice({ preset: "ingest" }), {
    ok: true,
    scopes: [...INGEST_SCOPES],
  });
  assert.deepEqual(
    resolveScopeChoice({
      preset: "custom",
      scopes: ["skills:read", "catalog:read", "skills:read"],
    }),
    {
      ok: true,
      scopes: ["catalog:read", "skills:read"],
    },
  );
  assert.equal(resolveScopeChoice({ preset: "custom", scopes: [] }).ok, false);
  assert.equal(resolveScopeChoice({ preset: "custom", scopes: ["*"] }).ok, false);
  assert.equal(resolveScopeChoice({ preset: "custom", scopes: ["catalog:delete"] }).ok, false);
  assert.equal(resolveScopeChoice({ preset: "admin" as never }).ok, false);
});

test("every scope has a label, and the 403 reason names the scope", () => {
  for (const scope of API_KEY_SCOPES) assert.ok(API_KEY_SCOPE_INFO[scope].label, scope);
  assert.match(missingScopeMessage("catalog:read"), /"catalog:read"/);
});

test("a publishable key carries its own prefix, a secret key does not", () => {
  const publishable = generateApiKey("publishable");
  assert.ok(publishable.plaintext.startsWith(PUBLISHABLE_KEY_PREFIX));
  assert.equal(publishable.prefix.length, PUBLISHABLE_KEY_PREFIX.length + 8);
  const secret = generateApiKey();
  assert.ok(secret.plaintext.startsWith("rtl_"));
  assert.ok(!secret.plaintext.startsWith(PUBLISHABLE_KEY_PREFIX));
});
