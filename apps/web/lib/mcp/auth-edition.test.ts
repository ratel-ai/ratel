import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { composition } from "@/lib/composition";
import type { McpOAuthPort } from "@/lib/contracts/mcp-oauth";
import { authenticateMcpRequest, defaultAuthDeps, editionOAuthVerifier } from "@/lib/mcp/auth";
import { APP_NAME } from "@/lib/platform/app-config";
import { resolvePlanId } from "@/lib/platform/entitlements";

/**
 * The edition seam of the MCP credential check (owned, no upstream counterpart): a bearer that is
 * not a project key goes to the composition's optional `mcpOAuth` port. `auth.test.ts`, mirrored
 * from upstream, covers the key path and the injected verifier.
 */

const acme = { id: "org-1", name: "Acme", slug: "acme" };
const caller = {
  externalUserId: "idp_user_1",
  userId: "user-1",
  memberships: [{ organization: acme, role: "admin" as const }],
};

const editionPort = composition.mcpOAuth;
afterEach(() => {
  composition.mcpOAuth = editionPort;
});

test("with no port, a bearer that is not a project key is refused and nobody is asked", async () => {
  const result = await editionOAuthVerifier(undefined)("ey.some.token");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "unauthorized");
  assert.match(result.error.message, /Only project API keys are accepted here/);
});

test("a verified caller becomes the oauth context, each organization with its plan", async () => {
  const seen: string[] = [];
  const port: McpOAuthPort = {
    verifyAccessToken: async (token) => {
      seen.push(token);
      return { ok: true, caller };
    },
  };
  const result = await editionOAuthVerifier(port)("ey.some.token");
  assert.deepEqual(seen, ["ey.some.token"]);
  assert.deepEqual(result, {
    ok: true,
    auth: {
      kind: "oauth",
      externalUserId: "idp_user_1",
      userId: "user-1",
      memberships: [
        {
          organizationId: "org-1",
          role: "admin",
          organization: { id: "org-1", slug: "acme", effectivePlan: resolvePlanId(acme) },
        },
      ],
    },
  });
});

test("an invalid token and an unlinked identity are both 401s, each saying what to do", async () => {
  const invalid = await editionOAuthVerifier({
    verifyAccessToken: async () => ({ ok: false, reason: "invalid" }),
  })("ey.expired");
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.error.code, "unauthorized");
  assert.equal(
    invalid.error.message,
    "Invalid or expired credential. Re-authenticate with your MCP client.",
  );

  const unlinked = await editionOAuthVerifier({
    verifyAccessToken: async () => ({ ok: false, reason: "unlinked" }),
  })("ey.stranger");
  assert.equal(unlinked.ok, false);
  if (unlinked.ok) return;
  assert.equal(unlinked.error.code, "unauthorized");
  assert.equal(
    unlinked.error.message,
    `No ${APP_NAME} account is linked to this identity. Sign in to the console once, then retry.`,
  );
});

test("the default credential check reads the port from the composition at call time", async () => {
  const request = new Request("http://console.local/api/mcp", {
    headers: { authorization: "Bearer ey.some.token" },
  });
  const deps = { ...defaultAuthDeps, isDbConfigured: () => true };

  composition.mcpOAuth = undefined;
  const refused = await authenticateMcpRequest(request, deps);
  assert.equal(refused.ok, false);

  composition.mcpOAuth = { verifyAccessToken: async () => ({ ok: true, caller }) };
  const accepted = await authenticateMcpRequest(request, deps);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.auth.kind, "oauth");
});
