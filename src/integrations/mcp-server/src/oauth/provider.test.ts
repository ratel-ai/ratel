import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatelOAuthProvider } from "./provider.js";
import { RatelOAuthStore } from "./store.js";

describe("RatelOAuthProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratel-prov-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeStore(name = "demo") {
    return new RatelOAuthStore(join(dir, "oauth", `${name}.json`));
  }

  it("clientMetadata exposes the configured redirect_uris and scope", () => {
    const provider = new RatelOAuthProvider({
      store: makeStore(),
      clientName: "Ratel test",
      redirectUrl: "http://127.0.0.1:9999/cb",
      scope: "read write",
    });
    expect(provider.clientMetadata.client_name).toBe("Ratel test");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:9999/cb"]);
    expect(provider.clientMetadata.scope).toBe("read write");
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(provider.clientMetadata.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(provider.clientMetadata.response_types).toEqual(["code"]);
  });

  it("redirectUrl reflects the constructor argument", () => {
    const a = new RatelOAuthProvider({
      store: makeStore("a"),
      redirectUrl: "http://127.0.0.1:1234/cb",
    });
    expect(String(a.redirectUrl)).toBe("http://127.0.0.1:1234/cb");

    const b = new RatelOAuthProvider({ store: makeStore("b") });
    expect(b.redirectUrl).toBeUndefined();
  });

  it("tokens() returns persisted tokens, undefined when none stored", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({ store });
    expect(await provider.tokens()).toBeUndefined();

    await store.save({ tokens: { access_token: "atk", token_type: "Bearer" } });
    expect((await provider.tokens())?.access_token).toBe("atk");
  });

  it("saveTokens writes through to the store and computes expires_at", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({ store });
    const before = Date.now();
    await provider.saveTokens({
      access_token: "atk",
      token_type: "Bearer",
      expires_in: 60,
    });
    const persisted = await store.load();
    expect(persisted.tokens?.access_token).toBe("atk");
    expect(persisted.expires_at ?? 0).toBeGreaterThanOrEqual(before + 60_000 - 50);
  });

  it("clientInformation prefers stored DCR result over the static client_id", async () => {
    const store = makeStore();
    await store.save({
      client_information: {
        client_id: "dcr-id",
        redirect_uris: ["http://127.0.0.1:1234/cb"],
      },
    });
    const provider = new RatelOAuthProvider({
      store,
      staticClientId: "static-id",
    });
    const info = await provider.clientInformation();
    expect(info?.client_id).toBe("dcr-id");
  });

  it("clientInformation falls back to the static client_id when nothing is stored", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({
      store,
      staticClientId: "static-id",
      staticClientSecret: "shh",
    });
    const info = await provider.clientInformation();
    expect(info?.client_id).toBe("static-id");
    expect(info?.client_secret).toBe("shh");
  });

  it("clientInformation returns undefined when neither stored nor static is set", async () => {
    const provider = new RatelOAuthProvider({ store: makeStore() });
    expect(await provider.clientInformation()).toBeUndefined();
  });

  it("saveClientInformation persists the DCR result", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({ store });
    await provider.saveClientInformation({
      client_id: "newly-registered",
      redirect_uris: ["http://127.0.0.1:1234/cb"],
    });
    const state = await store.load();
    expect(state.client_information?.client_id).toBe("newly-registered");
  });

  it("state() generates a CSRF token, persists it, and returns a fresh value on subsequent calls", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({ store });
    const s1 = await provider.state?.();
    expect(typeof s1).toBe("string");
    expect((s1 ?? "").length).toBeGreaterThanOrEqual(16);
    expect((await store.load()).state).toBe(s1);

    const s2 = await provider.state?.();
    expect(s2).not.toBe(s1);
    expect((await store.load()).state).toBe(s2);
  });

  it("saveCodeVerifier and codeVerifier round-trip through the store", async () => {
    const store = makeStore();
    const provider = new RatelOAuthProvider({ store });
    await provider.saveCodeVerifier("verify-me");
    expect(await provider.codeVerifier()).toBe("verify-me");
    expect((await store.load()).code_verifier).toBe("verify-me");
  });

  it("codeVerifier throws when no verifier has been stored", async () => {
    const provider = new RatelOAuthProvider({ store: makeStore() });
    await expect(provider.codeVerifier()).rejects.toThrow(/code verifier/i);
  });

  it("redirectToAuthorization invokes the configured handler with the URL", async () => {
    const seen: URL[] = [];
    const provider = new RatelOAuthProvider({
      store: makeStore(),
      redirectUrl: "http://127.0.0.1:1234/cb",
      onRedirect: (u) => {
        seen.push(u);
      },
    });
    const url = new URL("https://issuer.example/authorize?response_type=code");
    await provider.redirectToAuthorization(url);
    expect(seen).toEqual([url]);
  });

  it("redirectToAuthorization without a handler is a silent no-op", async () => {
    const provider = new RatelOAuthProvider({ store: makeStore() });
    await expect(
      provider.redirectToAuthorization(new URL("https://issuer.example/authorize")),
    ).resolves.toBeUndefined();
  });

  it("invalidateCredentials proxies through to the store with the matching scope", async () => {
    const store = makeStore();
    await store.save({
      tokens: { access_token: "atk", token_type: "Bearer" },
      client_information: { client_id: "cid", redirect_uris: ["http://127.0.0.1:1/cb"] },
      code_verifier: "v",
      discovery_state: { authorizationServerUrl: "https://x" },
    });
    const provider = new RatelOAuthProvider({ store });
    await provider.invalidateCredentials?.("tokens");
    expect((await store.load()).tokens).toBeUndefined();
    await provider.invalidateCredentials?.("verifier");
    expect((await store.load()).code_verifier).toBeUndefined();
    await provider.invalidateCredentials?.("all");
    expect(await store.load()).toEqual({});
  });

  it("saveDiscoveryState and discoveryState round-trip through the store", async () => {
    const provider = new RatelOAuthProvider({ store: makeStore() });
    await provider.saveDiscoveryState?.({
      authorizationServerUrl: "https://issuer.example",
    });
    const got = await provider.discoveryState?.();
    expect(got?.authorizationServerUrl).toBe("https://issuer.example");
  });
});
