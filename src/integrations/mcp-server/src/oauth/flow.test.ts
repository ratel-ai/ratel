import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerHandle } from "@ratel-ai/sdk";
import { ToolCatalog, type UpstreamServerInfo } from "@ratel-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEntry } from "../config.js";
import { type AuthStep, defaultAuthStep, runAuthFlow } from "./flow.js";
import { RatelOAuthStore } from "./store.js";

function fakeHandle(toolIds: string[] = []): McpServerHandle {
  return {
    toolIds,
    serverInstructions: undefined,
    close: vi.fn(async () => {}),
  };
}

describe("runAuthFlow", () => {
  function setup() {
    const catalog = new ToolCatalog();
    const upstreams: UpstreamServerInfo[] = [
      { name: "stripe", needsAuth: true },
      { name: "fs", toolCount: 2 },
      { name: "linear", needsAuth: true },
    ];
    const handles = new Map<string, McpServerHandle>();
    const configEntries: Record<string, ServerEntry> = {
      stripe: { type: "http", url: "https://mcp.stripe.example" },
      fs: { type: "stdio", command: "npx" },
      linear: { type: "http", url: "https://mcp.linear.example" },
    };
    return { catalog, upstreams, handles, configEntries };
  }

  it("runs the step against every upstream marked needsAuth when no name is given", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const seen: string[] = [];
    const step: AuthStep = async (name) => {
      seen.push(name);
      return { status: "authorized", handle: fakeHandle([`${name}__hello`]) };
    };

    const results = await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
    });

    expect(seen).toEqual(["stripe", "linear"]);
    expect(results.map((r) => r.name)).toEqual(["stripe", "linear"]);
    expect(results.every((r) => r.status === "authorized")).toBe(true);
  });

  it("runs against a single upstream when a name is given", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = vi.fn(async () => ({
      status: "authorized" as const,
      handle: fakeHandle([]),
    }));

    const results = await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      opts: { name: "stripe" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("stripe");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("flips needsAuth to false on success and updates toolCount", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = async (name) => ({
      status: "authorized",
      handle: fakeHandle([`${name}__a`, `${name}__b`]),
      description: `desc for ${name}`,
    });

    await runAuthFlow({ catalog, upstreams, handles, configEntries, step });

    const stripe = upstreams.find((u) => u.name === "stripe");
    expect(stripe?.needsAuth).toBeFalsy();
    expect(stripe?.toolCount).toBe(2);
    expect(stripe?.description).toBe("desc for stripe");
  });

  it("records step failures as failed rows without aborting the loop", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = async (name) => {
      if (name === "stripe") return { status: "failed", reason: "user denied" };
      return { status: "authorized", handle: fakeHandle([]) };
    };

    const results = await runAuthFlow({ catalog, upstreams, handles, configEntries, step });

    expect(results).toEqual([
      { name: "stripe", status: "failed", reason: "user denied" },
      { name: "linear", status: "authorized" },
    ]);

    const stripe = upstreams.find((u) => u.name === "stripe");
    expect(stripe?.needsAuth).toBe(true);
  });

  it("treats step throws as failed rows", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = async (name) => {
      if (name === "stripe") throw new Error("boom");
      return { status: "authorized", handle: fakeHandle([]) };
    };

    const results = await runAuthFlow({ catalog, upstreams, handles, configEntries, step });
    const stripeRow = results.find((r) => r.name === "stripe");
    expect(stripeRow?.status).toBe("failed");
    expect(stripeRow?.reason).toMatch(/boom/);
  });

  it("returns an empty array when no upstreams need auth and no name was given", async () => {
    const upstreams: UpstreamServerInfo[] = [{ name: "fs", toolCount: 1 }];
    const step: AuthStep = vi.fn();
    const results = await runAuthFlow({
      catalog: new ToolCatalog(),
      upstreams,
      handles: new Map(),
      configEntries: { fs: { type: "stdio", command: "x" } },
      step,
    });
    expect(results).toEqual([]);
    expect(step).not.toHaveBeenCalled();
  });

  it("returns a 'skipped' row when the named upstream is stdio (no auth applicable)", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = vi.fn();
    const results = await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      opts: { name: "fs" },
    });
    expect(results).toEqual([
      { name: "fs", status: "skipped", reason: "stdio entries do not use OAuth" },
    ]);
    expect(step).not.toHaveBeenCalled();
  });

  it("returns a single failed row when the named upstream is unknown", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = vi.fn();
    const results = await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      opts: { name: "ghost" },
    });
    expect(results).toEqual([{ name: "ghost", status: "failed", reason: "unknown upstream" }]);
  });

  it("calls onListChanged after every successful row", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const calls: string[] = [];
    const step: AuthStep = async (name) => ({
      status: "authorized",
      handle: fakeHandle([`${name}__x`]),
    });

    await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      onListChanged: () => {
        calls.push("changed");
      },
    });

    expect(calls).toEqual(["changed", "changed"]);
  });

  it("propagates the step's mode field through to AuthFlowResult", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const step: AuthStep = async () => ({
      status: "authorized",
      handle: fakeHandle([]),
      mode: "refresh",
    });
    const results = await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      opts: { name: "stripe" },
    });
    expect(results[0]).toMatchObject({ name: "stripe", status: "authorized", mode: "refresh" });
  });

  it("closes any pre-existing handle for the upstream before installing the new one", async () => {
    const { catalog, upstreams, handles, configEntries } = setup();
    const oldStripe = fakeHandle([]);
    handles.set("stripe", oldStripe);

    const step: AuthStep = async () => ({ status: "authorized", handle: fakeHandle([]) });
    await runAuthFlow({
      catalog,
      upstreams,
      handles,
      configEntries,
      step,
      opts: { name: "stripe" },
    });

    expect(oldStripe.close).toHaveBeenCalled();
  });
});

describe("defaultAuthStep", () => {
  let oauthDir: string;
  beforeEach(async () => {
    oauthDir = await mkdtemp(join(tmpdir(), "ratel-flow-oauth-"));
  });
  afterEach(async () => {
    await rm(oauthDir, { recursive: true, force: true });
  });
  function storePath(name: string): string {
    return join(oauthDir, `${name}.json`);
  }

  async function seedRefreshable(name: string): Promise<void> {
    const store = new RatelOAuthStore(storePath(name));
    await store.save({
      tokens: {
        access_token: "old",
        token_type: "Bearer",
        expires_in: 60,
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
    raw.expires_at = Date.now() - 1_000;
    await fs.writeFile(storePath(name), JSON.stringify(raw, null, 2));
  }

  it("refresh-first: skips the callback server when refreshTokens succeeds and returns mode='refresh'", async () => {
    await seedRefreshable("stripe");
    const callbackFactory = vi.fn();
    const refreshTokens = vi.fn(async () => undefined);
    const registerImpl = vi.fn(
      async (_catalog: ToolCatalog, opts: { name: string }): Promise<McpServerHandle> =>
        fakeHandle([`${opts.name}__hello`]),
    );

    const step = defaultAuthStep({
      storePath,
      callbackFactory: callbackFactory as never,
      refreshTokens,
      registerMcpServerImpl: registerImpl,
    });

    const result = await step(
      "stripe",
      { type: "http", url: "https://mcp.stripe.example" },
      { catalog: new ToolCatalog() },
    );

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(callbackFactory).not.toHaveBeenCalled();
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.mode).toBe("refresh");
    }
  });

  it("falls through to PKCE flow when refresh fails, returning mode='interactive'", async () => {
    await seedRefreshable("stripe");
    const refreshTokens = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    const pkceFlow = vi.fn(async () => ({
      status: "authorized" as const,
      handle: fakeHandle(["stripe__after-pkce"]),
      mode: "interactive" as const,
    }));

    const step = defaultAuthStep({ storePath, refreshTokens, pkceFlow });

    const result = await step(
      "stripe",
      { type: "http", url: "https://mcp.stripe.example" },
      { catalog: new ToolCatalog() },
    );

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(pkceFlow).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.mode).toBe("interactive");
    }
  });

  it("uses PKCE directly when no refresh_token is stored", async () => {
    // Seed with tokens but no refresh_token.
    const store = new RatelOAuthStore(storePath("stripe"));
    await store.save({
      tokens: { access_token: "old", token_type: "Bearer", expires_in: 60 },
    });
    const refreshTokens = vi.fn();
    const pkceFlow = vi.fn(async () => ({
      status: "authorized" as const,
      handle: fakeHandle(["stripe__pkce-only"]),
      mode: "interactive" as const,
    }));

    const step = defaultAuthStep({ storePath, refreshTokens, pkceFlow });
    const result = await step(
      "stripe",
      { type: "http", url: "https://mcp.stripe.example" },
      { catalog: new ToolCatalog() },
    );

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(pkceFlow).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("authorized");
  });
});
