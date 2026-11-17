import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import { API_KEY_SCOPES, INGEST_SCOPES, READ_ONLY_SCOPES } from "@/lib/platform/api-keys/scopes";

test("Full allows everything and is a secret key with no ingest restrictions", () => {
  const policy = apiKeyPolicy(["*"]);
  for (const scope of API_KEY_SCOPES) assert.ok(policy.allows(scope), scope);
  assert.equal(policy.access, "full");
  assert.equal(policy.kind, "secret");
  assert.equal(policy.publishable, false);
  assert.equal(policy.sharedKeyLimits, false);
  assert.equal(policy.appendOnlyIngest, false);
});

test("Ingest only allows the three ingest scopes and nothing else, and everything that follows from shipping it", () => {
  const policy = apiKeyPolicy([...INGEST_SCOPES]);
  for (const scope of API_KEY_SCOPES)
    assert.equal(policy.allows(scope), INGEST_SCOPES.includes(scope), scope);
  assert.equal(policy.access, "ingest");
  assert.equal(policy.kind, "publishable");
  assert.equal(policy.publishable, true);
  assert.equal(policy.sharedKeyLimits, true);
  assert.equal(policy.appendOnlyIngest, true);
});

test("Read-only allows reads only, and is a secret key", () => {
  const policy = apiKeyPolicy([...READ_ONLY_SCOPES]);
  assert.ok(policy.allows("catalog:read"));
  assert.ok(!policy.allows("skills:write"));
  assert.ok(!policy.allows("ingest:traces"));
  assert.ok(!policy.allows("content:read"));
  assert.equal(policy.access, "read_only");
  assert.equal(policy.publishable, false);
});

test("a key with no scopes, or a row missing them, allows nothing", () => {
  for (const scopes of [[], null, undefined]) {
    const policy = apiKeyPolicy(scopes);
    for (const scope of API_KEY_SCOPES) assert.ok(!policy.allows(scope), scope);
    assert.ok(!policy.allowsAny(["mcp:read", "mcp:write"]));
    assert.equal(policy.publishable, false);
  }
});

test("allowsAny passes when one of the scopes is held", () => {
  assert.ok(apiKeyPolicy(["mcp:write"]).allowsAny(["mcp:read", "mcp:write"]));
});

/**
 * The point of the policy: one place decides. Outside `scopes.ts` (the
 * primitives) and `policy.ts`, no module reads a scope list itself.
 */
test("no module outside the policy reads a key's scopes directly", () => {
  const webRoot = join(import.meta.dirname, "..", "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === "node_modules" || name.startsWith(".") ? [] : walk(path);
      return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
    });
  const allowed = new Set(["lib/platform/api-keys/scopes.ts", "lib/platform/api-keys/policy.ts"]);
  const offenders = ["lib", "app", "components"]
    .flatMap((dir) => walk(join(webRoot, dir)))
    .map((file) => ({
      file: relative(webRoot, file).split(sep).join("/"),
      source: readFileSync(file, "utf8"),
    }))
    .filter(({ file }) => !allowed.has(file))
    .filter(({ source }) => /\b(hasScope|isPublishableScopes|apiKeyAccess)\(/.test(source))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "ask apiKeyPolicy(scopes) instead");
});
