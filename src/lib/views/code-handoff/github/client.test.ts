import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstallationTokens } from "./app-auth";
import { createGitHubClient } from "./client";

const OAUTH = { clientId: "Iv1.client", clientSecret: "client-secret-value" };

function apiRepo(id: number) {
  return {
    id,
    name: `r${id}`,
    full_name: `acme/r${id}`,
    default_branch: "main",
    private: true,
    owner: { login: "acme" },
  };
}

function tokens(): InstallationTokens & { forgotten: number[]; issued: number } {
  const state = { forgotten: [] as number[], issued: 0 };
  return Object.assign(state, {
    async get() {
      state.issued += 1;
      return `tok-${state.issued}`;
    },
    forget(id: number) {
      state.forgotten.push(id);
    },
  });
}

test("listInstallationRepos follows pages until the total", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get("page"));
    const repositories =
      page === 1 ? Array.from({ length: 100 }, (_, i) => apiRepo(i + 1)) : [apiRepo(101)];
    return Response.json({ total_count: 101, repositories });
  }) as typeof fetch;
  const repos = await createGitHubClient({
    tokens: tokens(),
    oauthClient: OAUTH,
    fetch: fetchImpl,
  }).listInstallationRepos(5);
  assert.equal(repos.length, 101);
  assert.deepEqual(repos[100], {
    id: 101,
    owner: "acme",
    name: "r101",
    fullName: "acme/r101",
    defaultBranch: "main",
    private: true,
  });
  assert.equal(urls.length, 2);
});

test("getRepo and readFile read a 404 as null", async () => {
  const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
  const client = createGitHubClient({ tokens: tokens(), oauthClient: OAUTH, fetch: fetchImpl });
  assert.equal(await client.getRepo(1, { owner: "acme", name: "gone" }), null);
  assert.equal(await client.readFile(1, { owner: "acme", name: "gone", path: "src/a.ts" }), null);
});

test("a 401 drops the token and retries once with a fresh one", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string>).Authorization;
    seen.push(authorization);
    return authorization === "Bearer tok-1"
      ? new Response("", { status: 401 })
      : Response.json(apiRepo(3));
  }) as typeof fetch;
  const auth = tokens();
  const repo = await createGitHubClient({
    tokens: auth,
    oauthClient: OAUTH,
    fetch: fetchImpl,
  }).getRepo(9, { owner: "acme", name: "r3" });
  assert.equal(repo?.id, 3);
  assert.deepEqual(seen, ["Bearer tok-1", "Bearer tok-2"]);
  assert.deepEqual(auth.forgotten, [9]);
});

test("createIssue posts the issue and an error names the status, not the body or the token", async () => {
  let body: unknown;
  const ok = (async (_url: string | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json(
      { id: 77, number: 4, html_url: "https://github.com/acme/r1/issues/4" },
      { status: 201 },
    );
  }) as typeof fetch;
  const created = await createGitHubClient({
    tokens: tokens(),
    oauthClient: OAUTH,
    fetch: ok,
  }).createIssue(1, { owner: "acme", name: "r1", title: "T", body: "B" });
  assert.deepEqual(created, { id: 77, number: 4, url: "https://github.com/acme/r1/issues/4" });
  assert.deepEqual(body, { title: "T", body: "B" });

  const failing = (async () => new Response("body detail", { status: 422 })) as typeof fetch;
  await assert.rejects(
    createGitHubClient({ tokens: tokens(), oauthClient: OAUTH, fetch: failing }).createIssue(1, {
      owner: "acme",
      name: "r1",
      title: "T",
      body: "B",
    }),
    (error: Error) => /422/.test(error.message) && !/body detail|tok-/.test(error.message),
  );
});

test("exchangeUserCode posts the code with the App's OAuth client and returns the token, or null", async () => {
  let sent: { url: string; body: unknown } | null = null;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    const body = JSON.parse(String(init?.body)) as { code: string };
    return Response.json(
      body.code === "good"
        ? { access_token: "ghu_x", token_type: "bearer" }
        : { error: "bad_verification_code" },
    );
  }) as typeof fetch;
  const client = createGitHubClient({ tokens: tokens(), oauthClient: OAUTH, fetch: fetchImpl });
  assert.equal(await client.exchangeUserCode("good"), "ghu_x");
  assert.deepEqual(sent, {
    url: "https://github.com/login/oauth/access_token",
    body: { client_id: "Iv1.client", client_secret: "client-secret-value", code: "good" },
  });
  assert.equal(await client.exchangeUserCode("bad"), null);
  const failing = (async () => new Response("", { status: 500 })) as typeof fetch;
  assert.equal(
    await createGitHubClient({
      tokens: tokens(),
      oauthClient: OAUTH,
      fetch: failing,
    }).exchangeUserCode("good"),
    null,
  );
});

test("listUserInstallations reads every page with the user token", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>).Authorization);
    const page = Number(new URL(String(url)).searchParams.get("page"));
    const installations =
      page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }];
    return Response.json({ total_count: 101, installations });
  }) as typeof fetch;
  const ids = await createGitHubClient({
    tokens: tokens(),
    oauthClient: OAUTH,
    fetch: fetchImpl,
  }).listUserInstallations("ghu_x");
  assert.equal(ids.length, 101);
  assert.equal(ids[100], 101);
  assert.deepEqual(seen, ["Bearer ghu_x", "Bearer ghu_x"]);
});
