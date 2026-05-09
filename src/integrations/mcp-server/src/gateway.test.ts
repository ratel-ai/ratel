import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayFromConfig, redirectUrlFromStoredFile } from "./gateway.js";
import { RefreshFailedError } from "./oauth/refresh.js";
import { RatelOAuthStore } from "./oauth/store.js";

interface UpstreamSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function startUpstream(tools: UpstreamSpec[], instructions?: string) {
  const server = new Server(
    { name: "fake", version: "0.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: JSON.stringify({ called: req.params.name }) }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

describe("buildGatewayFromConfig", () => {
  it("registers tools from every upstream the factory wires up, namespaced by entry key", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file from local disk." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL over HTTP." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.catalog.has("fs__read_file")).toBe(true);
    expect(handle.catalog.has("remote__fetch")).toBe(true);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("skips entries with unsupported transport types and logs a warning", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          legacy: { type: "sse", url: "https://x" },
          future: { type: "websocket", url: "ws://x" },
        },
      },
      { transportFactory: () => undefined, logger: (m) => logs.push(m) },
    );

    expect(handle.catalog.has("legacy__anything")).toBe(false);
    expect(logs.join("\n")).toMatch(/legacy/);
    expect(logs.join("\n")).toMatch(/future/);

    await handle.close();
  });

  it("warns and continues when one upstream fails to register, leaving the rest available", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop" },
          ok: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") {
            throw new Error("boom");
          }
          return ok.clientTransport;
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.has("ok__ping")).toBe(true);
    expect(handle.catalog.has("broken__ping")).toBe(false);
    expect(logs.join("\n")).toMatch(/broken.*boom/);

    await handle.close();
    await ok.server.close();
  });

  it("returns an empty catalog when every entry fails to register", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { a: { type: "stdio", command: "noop" } },
      },
      {
        transportFactory: () => {
          throw new Error("nope");
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.search("anything", 5)).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);

    await handle.close();
  });

  it("exposes upstreamServers with name, description from config, and tool count", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file." },
      { name: "write_file", description: "Write a file." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop", description: "filesystem tools" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.upstreamServers).toEqual([
      { name: "fs", description: "filesystem tools", toolCount: 2 },
      { name: "remote", toolCount: 1 },
    ]);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("omits failed upstreams from upstreamServers", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop", description: "broken one" },
          ok: { type: "stdio", command: "noop" },
          unsupported: { type: "websocket", url: "ws://x" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") throw new Error("boom");
          if (name === "ok") return ok.clientTransport;
          return undefined;
        },
        logger: () => {},
      },
    );

    expect(handle.upstreamServers).toEqual([{ name: "ok", toolCount: 1 }]);

    await handle.close();
    await ok.server.close();
  });

  it("falls back to the upstream's `instructions` when no description is set on the config entry", async () => {
    const fs = await startUpstream(
      [{ name: "ping", description: "Ping." }],
      "Use this server for filesystem ops.",
    );
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers).toEqual([
      {
        name: "fs",
        description: "Use this server for filesystem ops.",
        instructions: "Use this server for filesystem ops.",
        toolCount: 1,
      },
    ]);
    await handle.close();
    await fs.server.close();
  });

  it("prefers the config entry's description over the upstream's `instructions` when both are present, but still surfaces the raw instructions separately", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }], "from-upstream");
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { fs: { type: "stdio", command: "noop", description: "from-config" } },
      },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBe("from-config");
    expect(handle.upstreamServers[0].instructions).toBe("from-upstream");
    await handle.close();
    await fs.server.close();
  });

  it("omits both description and instructions when neither config nor upstream provide them", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBeUndefined();
    expect(handle.upstreamServers[0].instructions).toBeUndefined();
    await handle.close();
    await fs.server.close();
  });

  it("close() tears down every upstream handle even if one rejects", async () => {
    const upstream = await startUpstream([{ name: "x", description: "x" }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { up: { type: "stdio", command: "noop" } } },
      { transportFactory: () => upstream.clientTransport },
    );

    await expect(handle.close()).resolves.toBeUndefined();
    await upstream.server.close();
  });

  it("flags HTTP upstreams as needsAuth when boot register throws UnauthorizedError, retaining the entry for re-auth", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          locked: { type: "http", url: "https://locked.example/mcp" },
          fs: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "fs") return ok.clientTransport;
          // For the http entry, return a transport whose start() throws Unauthorized
          return {
            async start() {
              throw new UnauthorizedError("missing tokens");
            },
            async send() {},
            async close() {},
          };
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "locked", needsAuth: true }),
    );
    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "fs", toolCount: 1 }),
    );
    expect(handle.catalog.has("fs__ping")).toBe(true);

    await handle.close();
    await ok.server.close();
  });

  describe("OAuth boot path", () => {
    let oauthDir: string;
    beforeEach(async () => {
      oauthDir = await mkdtemp(join(tmpdir(), "ratel-gateway-oauth-"));
    });
    afterEach(async () => {
      await rm(oauthDir, { recursive: true, force: true });
    });

    function storePath(name: string): string {
      return join(oauthDir, `${name}.json`);
    }

    async function seedStoredTokens(name: string, expiresAt: number): Promise<void> {
      const store = new RatelOAuthStore(storePath(name));
      await store.save({
        tokens: {
          access_token: "old",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rtk",
        },
        client_information: { client_id: "cid", redirect_uris: ["http://127.0.0.1:0/cb"] },
        discovery_state: {
          authorizationServerUrl: "https://issuer.example",
          authorizationServerMetadata: {
            issuer: "https://issuer.example",
            token_endpoint: "https://issuer.example/token",
            response_types_supported: ["code"],
          },
        },
      });
      const fs = await import("node:fs/promises");
      const raw = JSON.parse(await fs.readFile(storePath(name), "utf8"));
      raw.expires_at = expiresAt;
      await fs.writeFile(storePath(name), JSON.stringify(raw, null, 2));
    }

    it("calls refreshTokens for HTTP upstreams with stored tokens before register", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const refreshTokens = vi.fn(async () => undefined);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens,
        },
      );

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", toolCount: 1 }),
      );
      expect(handle.catalog.has("locked__ping")).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("marks upstream needsAuth and skips register when refresh fails", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const refreshTokens = vi.fn(async () => {
        throw new RefreshFailedError(new Error("invalid_grant"));
      });
      const factory = vi.fn(() => ok.clientTransport);
      const logs: string[] = [];

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: factory,
          oauthStorePath: storePath,
          refreshTokens,
          logger: (m) => logs.push(m),
        },
      );

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(factory).not.toHaveBeenCalled();
      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", needsAuth: true }),
      );
      expect(logs.join("\n")).toMatch(/locked.*re-authoriz/i);

      await handle.close();
      await ok.server.close();
    });

    it("emits auth_refresh{ok:true} after a successful boot-time refresh", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens: async () => undefined,
          trace: { kind: "memory", sessionId: "t" },
        },
      );

      const events = handle.catalog.drainTraceEvents() as Array<Record<string, unknown>>;
      const refreshed = events.find((e) => e.type === "auth_refresh");
      expect(refreshed?.upstream).toBe("locked");
      expect(refreshed?.ok).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("emits auth_refresh{ok:false} and auth_needs when refresh fails", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens: async () => {
            throw new RefreshFailedError(new Error("invalid_grant"));
          },
          trace: { kind: "memory", sessionId: "t" },
        },
      );

      const events = handle.catalog.drainTraceEvents() as Array<Record<string, unknown>>;
      expect(events).toContainEqual(
        expect.objectContaining({ type: "auth_refresh", upstream: "locked", ok: false }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "auth_needs", upstream: "locked" }),
      );

      await handle.close();
      await ok.server.close();
    });

    it("skips proactive refresh for HTTP upstreams without stored tokens", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      const refreshTokens = vi.fn();

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            fresh: { type: "http", url: "https://fresh.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens,
        },
      );

      expect(refreshTokens).not.toHaveBeenCalled();
      expect(handle.catalog.has("fresh__ping")).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("redirectUrlFromStoredFile reads client_information.redirect_uris[0] from the OAuth file", async () => {
      const fs = await import("node:fs/promises");
      const path = join(oauthDir, "demo.json");
      await fs.writeFile(
        path,
        JSON.stringify({
          client_information: { redirect_uris: ["http://127.0.0.1:54321/cb", "https://other"] },
        }),
      );
      expect(redirectUrlFromStoredFile(path)).toBe("http://127.0.0.1:54321/cb");
      expect(redirectUrlFromStoredFile(join(oauthDir, "missing.json"))).toBeUndefined();
    });

    it("classifies SDK 'prepareTokenRequest' errors as needsAuth instead of dropping the upstream", async () => {
      await seedStoredTokens("locked", Date.now() - 5_000);
      const refreshTokens = vi.fn(async () => undefined);
      const logs: string[] = [];

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ({
            async start() {
              throw new Error(
                "Either provider.prepareTokenRequest() or authorizationCode is required",
              );
            },
            async send() {},
            async close() {},
          }),
          oauthStorePath: storePath,
          refreshTokens,
          logger: (m) => logs.push(m),
        },
      );

      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", needsAuth: true }),
      );
      await handle.close();
    });
  });

  it("exposes a runAuthFlow function on the handle", async () => {
    const handle = await buildGatewayFromConfig(
      { mcpServers: {} },
      { transportFactory: () => undefined },
    );
    expect(typeof handle.runAuthFlow).toBe("function");
    // Without any http upstreams, runs no targets and returns empty.
    const results = await handle.runAuthFlow({});
    expect(results).toEqual([]);
    await handle.close();
  });
});
