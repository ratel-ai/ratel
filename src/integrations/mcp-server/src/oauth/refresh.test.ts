import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissingDiscoveryError,
  NoRefreshTokenError,
  RefreshFailedError,
  refreshIfNeeded,
} from "./refresh.js";
import { RatelOAuthStore } from "./store.js";

describe("refreshIfNeeded", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratel-refresh-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function newStore(name = "demo"): RatelOAuthStore {
    return new RatelOAuthStore(join(dir, "oauth", `${name}.json`));
  }

  async function seed(
    store: RatelOAuthStore,
    overrides: { expires_at?: number; refresh_token?: string | undefined } = {},
  ): Promise<void> {
    const tokens: OAuthTokens = {
      access_token: "old-access",
      token_type: "Bearer",
      expires_in: 3600,
    };
    if (!("refresh_token" in overrides) || overrides.refresh_token !== undefined) {
      tokens.refresh_token = overrides.refresh_token ?? "rtk-old";
    }
    await store.save({
      tokens,
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
    if (overrides.expires_at !== undefined) {
      const fs = await import("node:fs/promises");
      const filePath = join(dir, "oauth", "demo.json");
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.expires_at = overrides.expires_at;
      await fs.writeFile(filePath, JSON.stringify(raw, null, 2));
    }
  }

  it("hot path: returns fresh tokens without invoking refreshFn", async () => {
    const store = newStore();
    await seed(store, { expires_at: Date.now() + 24 * 3600 * 1000 });
    const refreshFn = vi.fn();
    const outcome = await refreshIfNeeded(store, { refreshFn: refreshFn as never });
    expect(outcome.kind).toBe("fresh");
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("N concurrent callers issue exactly one refresh and converge on the same tokens", async () => {
    const store = newStore();
    await seed(store, { expires_at: Date.now() - 5_000 });

    let calls = 0;
    const refreshFn = vi.fn(async (): Promise<OAuthTokens> => {
      calls++;
      // Slight delay so all 5 callers race.
      await new Promise((r) => setTimeout(r, 20));
      return {
        access_token: `new-${calls}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `rtk-${calls}`,
      };
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => refreshIfNeeded(store, { refreshFn })),
    );

    expect(refreshFn).toHaveBeenCalledTimes(1);
    const refreshed = outcomes.filter((o) => o.kind === "refreshed");
    const raced = outcomes.filter((o) => o.kind === "raced");
    expect(refreshed.length).toBe(1);
    expect(raced.length).toBe(4);
    for (const o of [...refreshed, ...raced]) {
      expect(o.tokens.access_token).toBe("new-1");
    }
    expect((await store.load()).tokens?.access_token).toBe("new-1");
  });

  it("refresh failure clears tokens and raises RefreshFailedError", async () => {
    const store = newStore();
    await seed(store, { expires_at: Date.now() - 5_000 });
    const refreshFn = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    await expect(refreshIfNeeded(store, { refreshFn: refreshFn as never })).rejects.toBeInstanceOf(
      RefreshFailedError,
    );
    const persisted = await store.load();
    expect(persisted.tokens).toBeUndefined();
    expect(persisted.expires_at).toBeUndefined();
    // Other state survives: client_information, discovery, etc.
    expect(persisted.client_information?.client_id).toBe("cid");
    expect(persisted.discovery_state?.authorizationServerUrl).toBe("https://issuer.example");
  });

  it("throws NoRefreshTokenError when tokens lack a refresh_token", async () => {
    const store = newStore();
    await seed(store, { refresh_token: undefined, expires_at: Date.now() - 1_000 });
    await expect(refreshIfNeeded(store)).rejects.toBeInstanceOf(NoRefreshTokenError);
  });

  it("throws MissingDiscoveryError when discovery_state is absent", async () => {
    const store = newStore();
    await store.save({
      tokens: {
        access_token: "old",
        token_type: "Bearer",
        expires_in: 1,
        refresh_token: "rtk",
      },
      client_information: { client_id: "cid", redirect_uris: ["http://127.0.0.1:0/cb"] },
    });
    // expires_in: 1 means expires_at is ~1s from now; wait it out so we hit refresh path.
    await new Promise((r) => setTimeout(r, 1100));
    await expect(refreshIfNeeded(store)).rejects.toBeInstanceOf(MissingDiscoveryError);
  });

  it("calls the refresh function and persists new tokens when expired", async () => {
    const store = newStore();
    await seed(store, { expires_at: Date.now() - 5_000 });

    const refreshFn = vi.fn(
      async (): Promise<OAuthTokens> => ({
        access_token: "new-access",
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: "rtk-new",
      }),
    );

    const outcome = await refreshIfNeeded(store, { refreshFn });

    expect(outcome.kind).toBe("refreshed");
    expect(outcome.tokens.access_token).toBe("new-access");
    expect(refreshFn).toHaveBeenCalledTimes(1);

    const persisted = await store.load();
    expect(persisted.tokens?.access_token).toBe("new-access");
    expect(persisted.tokens?.refresh_token).toBe("rtk-new");
    expect(persisted.expires_at ?? 0).toBeGreaterThan(Date.now() + 7000_000);
  });
});
