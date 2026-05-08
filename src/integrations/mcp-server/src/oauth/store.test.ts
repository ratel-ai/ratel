import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatelOAuthStore } from "./store.js";

describe("RatelOAuthStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratel-oauth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function newStore(name = "demo") {
    return new RatelOAuthStore(join(dir, "oauth", `${name}.json`));
  }

  it("load returns an empty state when the file does not exist", async () => {
    const store = newStore();
    expect(await store.load()).toEqual({});
  });

  it("save → load round-trips tokens and computes expires_at", async () => {
    const store = newStore();
    const before = Date.now();
    await store.save({
      tokens: {
        access_token: "atk",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rtk",
      },
    });
    const state = await store.load();
    expect(state.tokens?.access_token).toBe("atk");
    expect(state.tokens?.refresh_token).toBe("rtk");
    expect(typeof state.expires_at).toBe("number");
    expect(state.expires_at ?? 0).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50);
    expect(state.expires_at ?? 0).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 50);
  });

  it("save without expires_in clears expires_at", async () => {
    const store = newStore();
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer" },
    });
    const state = await store.load();
    expect(state.expires_at).toBeUndefined();
  });

  it("save merges partial updates without dropping previously stored fields", async () => {
    const store = newStore();
    await store.save({
      client_information: {
        client_id: "abc",
        redirect_uris: ["http://127.0.0.1:0/cb"],
      },
    });
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer", expires_in: 60 },
    });
    const state = await store.load();
    expect(state.client_information?.client_id).toBe("abc");
    expect(state.tokens?.access_token).toBe("atk");
  });

  it("clear('tokens') drops tokens and expires_at but keeps client_information", async () => {
    const store = newStore();
    await store.save({
      client_information: { client_id: "abc", redirect_uris: ["http://127.0.0.1:0/cb"] },
      tokens: { access_token: "atk", token_type: "Bearer", expires_in: 60 },
    });
    await store.clear("tokens");
    const state = await store.load();
    expect(state.tokens).toBeUndefined();
    expect(state.expires_at).toBeUndefined();
    expect(state.client_information?.client_id).toBe("abc");
  });

  it("clear('all') removes the file entirely", async () => {
    const store = newStore();
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer" },
    });
    await store.clear("all");
    expect(await store.load()).toEqual({});
  });

  it("clear('verifier') and clear('discovery') drop the matching scope only", async () => {
    const store = newStore();
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer" },
      code_verifier: "verif",
      discovery_state: {
        authorizationServerUrl: "https://issuer.example",
      },
    });
    await store.clear("verifier");
    let state = await store.load();
    expect(state.code_verifier).toBeUndefined();
    expect(state.tokens?.access_token).toBe("atk");
    expect(state.discovery_state?.authorizationServerUrl).toBe("https://issuer.example");
    await store.clear("discovery");
    state = await store.load();
    expect(state.discovery_state).toBeUndefined();
    expect(state.tokens?.access_token).toBe("atk");
  });

  it("rejects malformed token payloads with a clear error", async () => {
    const store = newStore();
    const filePath = join(dir, "oauth", "demo.json");
    await mkdir(join(dir, "oauth"), { recursive: true });
    await writeFile(filePath, JSON.stringify({ tokens: { token_type: "Bearer" } }));
    await expect(store.load()).rejects.toThrow(/access_token/);
  });

  it("creates the parent directory with mode 0700 and the file with mode 0600", async () => {
    const store = newStore();
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer" },
    });
    const dirStat = await stat(join(dir, "oauth"));
    const fileStat = await stat(join(dir, "oauth", "demo.json"));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("withLock serializes overlapping callers on the same path", async () => {
    const store = newStore();
    const events: string[] = [];
    const a = store.withLock(async () => {
      events.push("a:start");
      await new Promise((r) => setTimeout(r, 50));
      events.push("a:end");
    });
    const b = store.withLock(async () => {
      events.push("b:start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("b:end");
    });
    await Promise.all([a, b]);
    // Either order is fine; what matters is they don't interleave.
    const order = events.join(",");
    expect(order === "a:start,a:end,b:start,b:end" || order === "b:start,b:end,a:start,a:end").toBe(
      true,
    );
  });

  it("withLock releases the lock when fn throws", async () => {
    const store = newStore();
    await expect(
      store.withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent withLock must succeed promptly (no stale held lock).
    const t0 = Date.now();
    await store.withLock(async () => undefined);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("save() inside withLock reuses the held lock without deadlocking", async () => {
    const store = newStore();
    await store.withLock(async () => {
      await store.save({ code_verifier: "inside" });
    });
    expect((await store.load()).code_verifier).toBe("inside");
  });

  it("withLock on different paths runs in parallel", async () => {
    const a = newStore("a");
    const b = newStore("b");
    const events: string[] = [];
    await Promise.all([
      a.withLock(async () => {
        events.push("a:start");
        await new Promise((r) => setTimeout(r, 50));
        events.push("a:end");
      }),
      b.withLock(async () => {
        events.push("b:start");
        await new Promise((r) => setTimeout(r, 50));
        events.push("b:end");
      }),
    ]);
    // If they ran in parallel, both starts come before either end.
    const startA = events.indexOf("a:start");
    const startB = events.indexOf("b:start");
    const endA = events.indexOf("a:end");
    const endB = events.indexOf("b:end");
    expect(startA).toBeLessThan(endB);
    expect(startB).toBeLessThan(endA);
  });

  it("concurrent save() calls do not lose updates", async () => {
    const store = newStore();
    await store.save({
      client_information: { client_id: "abc", redirect_uris: ["http://127.0.0.1:0/cb"] },
    });
    await Promise.all([
      store.save({ code_verifier: "verif" }),
      store.save({ state: "stt" }),
      store.save({
        tokens: { access_token: "atk", token_type: "Bearer", expires_in: 60 },
      }),
    ]);
    const state = await store.load();
    expect(state.client_information?.client_id).toBe("abc");
    expect(state.code_verifier).toBe("verif");
    expect(state.state).toBe("stt");
    expect(state.tokens?.access_token).toBe("atk");
  });

  it("writes atomically: an interrupted write does not corrupt an existing file", async () => {
    const store = newStore();
    await store.save({ tokens: { access_token: "good", token_type: "Bearer" } });
    const filePath = join(dir, "oauth", "demo.json");
    const original = await readFile(filePath, "utf8");

    await expect(
      store.save({
        tokens: {
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid for the test
          access_token: 42 as any,
          token_type: "Bearer",
        },
      }),
    ).rejects.toThrow();

    const after = await readFile(filePath, "utf8");
    expect(after).toBe(original);
  });
});
