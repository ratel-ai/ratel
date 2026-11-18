import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMcpSnippet,
  buildMcpSnippetSet,
  MCP_CLIENTS,
  MCP_KEY_ENV,
  MCP_KEY_PLACEHOLDER,
} from "./snippets";

const ENDPOINT = "https://ratel.example.com/api/mcp";
const MINTED = "rtl_TESTKEYqQ2v8xN4mLpZ1aB3cD5eF";

test("every client produces a snippet carrying the project's endpoint", () => {
  const set = buildMcpSnippetSet({ endpoint: ENDPOINT });

  for (const client of MCP_CLIENTS) {
    assert.ok(set[client], `${client} must have a snippet`);
    assert.ok(set[client].code.includes(ENDPOINT), `${client} snippet must contain the endpoint`);
  }
});

test("no snippet ever contains a real-looking key it was not given", () => {
  for (const client of MCP_CLIENTS) {
    const { code } = buildMcpSnippet(client, { endpoint: ENDPOINT });
    assert.ok(
      !/rtl_[A-Za-z0-9_-]{20,}/.test(code),
      `${client} must not contain a real-looking key`,
    );
  }
});

/**
 * There is no browser sign-in in this edition, so every client has to carry a
 * key. Pinned because a snippet that silently dropped it would connect, be
 * refused with a 401, and leave the reader with nothing to act on.
 */
test("every client sends the project key, named by its env var", () => {
  for (const client of MCP_CLIENTS) {
    const snippet = buildMcpSnippet(client, { endpoint: ENDPOINT });
    assert.equal(snippet.auth, "key", `${client} must authenticate with a key`);
    assert.ok(snippet.code.includes(MCP_KEY_ENV), `${client} must name the key env var`);
  }
});

test("a minted key is filled into the shell and desktop snippets, never the editor config", () => {
  const set = buildMcpSnippetSet({ endpoint: ENDPOINT, apiKey: MINTED });

  for (const client of ["claude-code", "claude-desktop", "cli"] as const) {
    assert.ok(set[client].code.includes(MINTED), `${client} should carry the key`);
    assert.ok(
      !set[client].code.includes(MCP_KEY_PLACEHOLDER),
      `${client} must not keep the placeholder`,
    );
  }
  // This file is commonly committed, so it is the worst place for a secret.
  assert.ok(!set.cursor.code.includes(MINTED));
});

test("without a minted key the shell and desktop snippets show the placeholder", () => {
  const set = buildMcpSnippetSet({ endpoint: ENDPOINT });

  for (const client of ["claude-code", "claude-desktop", "cli"] as const) {
    assert.ok(
      set[client].code.includes(MCP_KEY_PLACEHOLDER),
      `${client} should show where the key goes`,
    );
  }
});

test("the editor config is valid JSON, reads the key from the environment and carries no secret", () => {
  const { code } = buildMcpSnippet("cursor", { endpoint: ENDPOINT, apiKey: MINTED });

  const parsed = JSON.parse(code) as {
    mcpServers: { ratel: { url: string; headers: Record<string, string> } };
  };
  assert.equal(parsed.mcpServers.ratel.url, ENDPOINT);
  assert.equal(parsed.mcpServers.ratel.headers.Authorization, `Bearer \${env:${MCP_KEY_ENV}}`);
  assert.ok(!code.includes(MINTED));
});

test("the desktop config is valid JSON and routes through the bridge with the key in its env", () => {
  const { code } = buildMcpSnippet("claude-desktop", { endpoint: ENDPOINT, apiKey: MINTED });

  const parsed = JSON.parse(code) as {
    mcpServers: { ratel: { command: string; args: string[]; env: Record<string, string> } };
  };
  assert.equal(parsed.mcpServers.ratel.command, "npx");
  assert.ok(parsed.mcpServers.ratel.args.includes("mcp-remote"));
  assert.ok(parsed.mcpServers.ratel.args.includes(ENDPOINT));
  assert.equal(parsed.mcpServers.ratel.env[MCP_KEY_ENV], MINTED);
});

test("Claude Code uses the http transport with the header, not a stdio bridge", () => {
  const { code } = buildMcpSnippet("claude-code", { endpoint: ENDPOINT });

  assert.match(code, /--transport http/);
  assert.match(code, /--header "Authorization: Bearer \$RATEL_API_KEY"/);
  assert.ok(!code.includes("mcp-remote"), "native http support needs no bridge");
});

test("the CI auth header is quoted so a shell cannot split it", () => {
  const { code } = buildMcpSnippet("cli", { endpoint: ENDPOINT });

  assert.match(code, /--header "Authorization: Bearer \$RATEL_API_KEY"/);
});

/*
 * With browser sign-in (an edition that supplies the `mcpOAuth` port), upstream's
 * cases: the interactive clients sign in and carry no key; only CI keeps one.
 */
const SIGN_IN = { endpoint: ENDPOINT, browserSignIn: true } as const;

test("browser sign-in: every client still carries the endpoint and no key it was not given", () => {
  const set = buildMcpSnippetSet(SIGN_IN);

  for (const client of MCP_CLIENTS) {
    assert.ok(set[client].code.includes(ENDPOINT), `${client} snippet must contain the endpoint`);
    assert.ok(
      !/rtl_[A-Za-z0-9_-]{20,}/.test(set[client].code),
      `${client} must not contain a real-looking key`,
    );
  }
});

/**
 * The browser clients stopped needing a key once the discovery chain existed.
 * Pinned because it is the difference between "paste a URL" and "generate a
 * credential, paste it into a config file", which is the whole friction budget.
 */
test("interactive clients authenticate through the browser, with no key at all", () => {
  for (const client of ["claude-code", "claude-desktop", "cursor"] as const) {
    const snippet = buildMcpSnippet(client, SIGN_IN);
    assert.equal(snippet.auth, "oauth", `${client} should sign in, not carry a secret`);
    assert.ok(!snippet.code.includes(MCP_KEY_ENV), `${client} must not mention a key env var`);
    assert.ok(
      !snippet.code.includes(MCP_KEY_PLACEHOLDER),
      `${client} must not show a key placeholder`,
    );
  }
});

test("CI keeps the key path, because there is no browser to sign in with", () => {
  const snippet = buildMcpSnippet("cli", SIGN_IN);

  assert.equal(snippet.auth, "key");
  assert.ok(snippet.code.includes(MCP_KEY_ENV));
});

test("a minted key reaches only the client that asked for one", () => {
  const set = buildMcpSnippetSet({ ...SIGN_IN, apiKey: MINTED });

  assert.ok(set.cli.code.includes(MINTED), "CI should carry the key");
  for (const client of ["claude-code", "claude-desktop", "cursor"] as const) {
    assert.ok(
      !set[client].code.includes(MINTED),
      `${client} signs in through the browser and must not be handed a secret`,
    );
  }
});

test("browser sign-in: the editor config is valid JSON and carries no secret", () => {
  const { code } = buildMcpSnippet("cursor", { ...SIGN_IN, apiKey: MINTED });

  assert.doesNotThrow(() => JSON.parse(code), "mcp.json must parse");
  assert.deepEqual(JSON.parse(code), { mcpServers: { ratel: { url: ENDPOINT } } });
  // This file is commonly committed, so it is the worst place for a secret.
  assert.ok(!code.includes(MINTED));
  assert.ok(!code.includes(MCP_KEY_ENV));
});

test("browser sign-in: Claude Code uses the http transport, not a stdio bridge", () => {
  const { code } = buildMcpSnippet("claude-code", SIGN_IN);

  assert.match(code, /--transport http/);
  assert.ok(!code.includes("mcp-remote"), "native http support needs no bridge");
});

test("browser sign-in: Claude Desktop takes the URL itself", () => {
  const snippet = buildMcpSnippet("claude-desktop", SIGN_IN);

  assert.equal(snippet.code, ENDPOINT);
  assert.equal(
    snippet.note,
    "Settings -> Connectors -> Add custom connector, then paste this URL.",
  );
});

test("browser sign-in: the CI auth header is quoted so a shell cannot split it", () => {
  const { code } = buildMcpSnippet("cli", SIGN_IN);

  assert.match(code, /--header "Authorization: Bearer \$RATEL_API_KEY"/);
});
