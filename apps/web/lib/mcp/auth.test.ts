import assert from "node:assert/strict";
import { test } from "node:test";
import { generateApiKey } from "@/lib/platform/api-keys";
import {
  authDistinctId,
  authenticateMcpRequest,
  bearerToken,
  type McpAuthContext,
  type McpAuthDeps,
  membershipFor,
} from "./auth";
import { McpOperationError } from "./errors";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://cloud.ratel.sh/api/mcp", { method: "POST", headers });
}

function deps(overrides: Partial<McpAuthDeps> = {}): McpAuthDeps {
  return {
    isDbConfigured: () => true,
    findActiveApiKeyByHash: async () => ({ id: "key-1", projectId: PROJECT }) as never,
    touchApiKey: async () => undefined as never,
    getOrganizationByProjectId: async () =>
      ({
        id: "org-1",
        slug: "acme",
        plan: "pro",
        subscriptionStatus: "active",
        planOverride: null,
        limitOverrides: null,
      }) as never,
    verifyOAuthToken: async () => ({
      ok: false,
      error: new McpOperationError("unauthorized", "no oauth in this fixture"),
    }),
    ...overrides,
  };
}

test("bearerToken accepts a well-formed header and rejects anything else", () => {
  assert.equal(bearerToken(request({ authorization: "Bearer rtl_abc" })), "rtl_abc");
  assert.equal(bearerToken(request({ authorization: "rtl_abc" })), null);
  assert.equal(bearerToken(request()), null);
});

test("a missing credential is unauthorized", async () => {
  const result = await authenticateMcpRequest(request(), deps());

  assert.ok(!result.ok);
  assert.equal(result.error.code, "unauthorized");
});

test("a valid key resolves to its project and organization", async () => {
  const key = generateApiKey();
  const result = await authenticateMcpRequest(
    request({ authorization: `Bearer ${key.plaintext}` }),
    deps(),
  );

  assert.ok(result.ok);
  assert.equal(result.auth.kind, "api-key");
  assert.equal(result.auth.kind === "api-key" && result.auth.projectId, PROJECT);
  assert.equal(result.auth.kind === "api-key" && result.auth.organization?.id, "org-1");
});

test("an unknown key is rejected without saying which part was wrong", async () => {
  const key = generateApiKey();
  const result = await authenticateMcpRequest(
    request({ authorization: `Bearer ${key.plaintext}` }),
    deps({ findActiveApiKeyByHash: async () => null }),
  );

  assert.ok(!result.ok);
  assert.equal(result.error.code, "unauthorized");
});

test("a non-rtl_ bearer is handed to the OAuth verifier, not rejected outright", async () => {
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_123",
    userId: "u1",
    memberships: [
      {
        organizationId: "org-1",
        role: "admin",
        organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
      },
    ],
  };
  const seen: string[] = [];

  const result = await authenticateMcpRequest(
    request({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig" }),
    deps({
      verifyOAuthToken: async (token) => {
        seen.push(token);
        return { ok: true, auth: oauth };
      },
    }),
  );

  assert.ok(result.ok);
  assert.equal(result.auth.kind, "oauth");
  assert.deepEqual(seen, ["eyJhbGciOiJSUzI1NiJ9.payload.sig"]);
});

test("an API key never reaches the OAuth verifier", async () => {
  const key = generateApiKey();
  let called = false;

  await authenticateMcpRequest(
    request({ authorization: `Bearer ${key.plaintext}` }),
    deps({
      verifyOAuthToken: async () => {
        called = true;
        return { ok: false, error: new McpOperationError("unauthorized", "x") };
      },
    }),
  );

  assert.equal(called, false, "the two credential kinds must not cross paths");
});

test("membership lookup answers which organizations an OAuth caller reaches", () => {
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_123",
    userId: "u1",
    memberships: [
      {
        organizationId: "org-1",
        role: "admin",
        organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
      },
    ],
  };

  assert.equal(membershipFor(oauth, "org-1")?.role, "admin");
  assert.equal(membershipFor(oauth, "org-other"), null);
});

test("no database means unavailable, not unauthorized", async () => {
  const key = generateApiKey();
  const result = await authenticateMcpRequest(
    request({ authorization: `Bearer ${key.plaintext}` }),
    deps({ isDbConfigured: () => false }),
  );

  assert.ok(!result.ok);
  assert.equal(result.error.code, "unavailable");
});

test("a valid key stamps last-used exactly once", async () => {
  const touched: string[] = [];
  const key = generateApiKey();
  await authenticateMcpRequest(
    request({ authorization: `Bearer ${key.plaintext}` }),
    deps({
      touchApiKey: async (id: string) => {
        touched.push(id);
        return undefined as never;
      },
    }),
  );

  assert.deepEqual(touched, ["key-1"]);
});

test("analytics identity is the project, matching ingest", () => {
  assert.equal(
    authDistinctId({
      kind: "api-key",
      projectId: PROJECT,
      apiKeyId: "key-1",
      organization: null,
    }),
    `project:${PROJECT}`,
  );
});
