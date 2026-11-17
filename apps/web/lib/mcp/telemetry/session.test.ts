import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { DERIVED_SESSION_WINDOW_MS, mcpClientName, mcpCredentialId, mcpSessionId } from "./session";

const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);

test("the Mcp-Session-Id header wins when the client sends one", () => {
  const headers = new Headers({ "mcp-session-id": "client-session-1" });
  assert.deepEqual(mcpSessionId(headers, "key:k1", "claude-code", T0), {
    id: "client-session-1",
    source: "header",
  });
});

test("without the header the id is derived from credential, client and a 30 min window", () => {
  const a = mcpSessionId(new Headers(), "key:k1", "claude-code", T0);
  assert.equal(a.source, "derived");
  assert.match(a.id, /^derived-[0-9a-f]{32}$/);
  // Same caller, same window: same session, on any server task.
  assert.equal(
    mcpSessionId(null, "key:k1", "claude-code", T0 + DERIVED_SESSION_WINDOW_MS - 1).id,
    a.id,
  );
  // Another credential, another client or the next window: another session.
  assert.notEqual(mcpSessionId(null, "key:k2", "claude-code", T0).id, a.id);
  assert.notEqual(mcpSessionId(null, "key:k1", "codex", T0).id, a.id);
  assert.notEqual(
    mcpSessionId(null, "key:k1", "claude-code", T0 + DERIVED_SESSION_WINDOW_MS).id,
    a.id,
  );
});

test("the client name is the User-Agent product, or unknown", () => {
  assert.equal(
    mcpClientName(new Headers({ "user-agent": "claude-code/2.1.3 (cli)" })),
    "claude-code",
  );
  assert.equal(mcpClientName(new Headers({ "user-agent": "  " })), "unknown");
  assert.equal(mcpClientName(null), "unknown");
});

test("the credential id names the key or the user, never a secret", () => {
  const key: McpAuthContext = {
    kind: "api-key",
    projectId: "p1",
    apiKeyId: "k1",
    scopes: ["*"],
    organization: null,
  };
  const user: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_c",
    userId: "u1",
    memberships: [],
  };
  assert.equal(mcpCredentialId(key), "key:k1");
  assert.equal(mcpCredentialId(user), "user:u1");
});
