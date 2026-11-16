import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  defaultLaunchAccessDeps,
  type LaunchAccessDeps,
  mcpLaunchAccess,
  resetLaunchAccessCache,
} from "./launch-access";

/**
 * The MCP server's door is the app's: a person gets in when the console would let them in
 * (upstream RC-234). A project key is not a person and is not asked. Owned: the person is named
 * by `externalUserId`, and the decision comes from the edition.
 */
const KEY: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function person(externalUserId: string): McpAuthContext {
  return { kind: "oauth", externalUserId, userId: `row-${externalUserId}`, memberships: [] };
}

function deps(
  decide: LaunchAccessDeps["decide"],
  now = () => 0,
): { deps: LaunchAccessDeps; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      decide: async (externalUserId) => {
        asked.push(externalUserId);
        return decide(externalUserId);
      },
      now,
    },
  };
}

beforeEach(() => resetLaunchAccessCache());

test("a project API key is let through without asking", async () => {
  const { deps: d, asked } = deps(async () => false);
  assert.equal(await mcpLaunchAccess(KEY, d), true);
  assert.deepEqual(asked, []);
});

test("a person is decided by the edition, by their identity provider id", async () => {
  const { deps: d, asked } = deps(async () => true);
  assert.equal(await mcpLaunchAccess(person("user_a"), d), true);
  assert.deepEqual(asked, ["user_a"]);
});

test("a grant is cached for five minutes, then asked again", async () => {
  let clock = 0;
  const { deps: d, asked } = deps(
    async () => true,
    () => clock,
  );
  await mcpLaunchAccess(person("user_b"), d);
  clock = 4 * 60_000;
  await mcpLaunchAccess(person("user_b"), d);
  assert.equal(asked.length, 1);
  clock = 6 * 60_000;
  await mcpLaunchAccess(person("user_b"), d);
  assert.equal(asked.length, 2);
});

test("a refusal is not cached, so someone granted mid-session gets in on their next call", async () => {
  let granted = false;
  const { deps: d } = deps(async () => granted);
  assert.equal(await mcpLaunchAccess(person("user_c"), d), false);
  granted = true;
  assert.equal(await mcpLaunchAccess(person("user_c"), d), true);
});

test("a failed decision refuses, as the console's check does", async () => {
  const { deps: d } = deps(async () => {
    throw new Error("identity provider down");
  });
  assert.equal(await mcpLaunchAccess(person("user_d"), d), false);
});

test("with no edition decision wired, a signed-in caller is refused and a key still passes", async () => {
  assert.equal(await mcpLaunchAccess(person("user_e"), defaultLaunchAccessDeps), false);
  assert.equal(await mcpLaunchAccess(KEY, defaultLaunchAccessDeps), true);
});
