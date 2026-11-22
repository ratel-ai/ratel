import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createInstallationTokens, REFRESH_MARGIN_MS, signAppJwt } from "./app-auth";

// A throwaway key made for this test run only.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const START = Date.parse("2026-11-17T10:00:00Z");
const HOUR = 60 * 60_000;

/** GitHub's token endpoint, handing out `token-<n>` valid for one hour from the fake clock. */
function fakeGitHub(clock: { now: number }) {
  const calls: { url: string; authorization: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), authorization: headers.Authorization });
    const body = {
      token: `token-${calls.length}`,
      expires_at: new Date(clock.now + HOUR).toISOString(),
    };
    return new Response(JSON.stringify(body), { status: 201 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("signAppJwt is an RS256 JWT for the App, valid under ten minutes", () => {
  const jwt = signAppJwt("12345", PEM, START);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.ok(claims.iat < START / 1000 && claims.exp > START / 1000);
  assert.ok(claims.exp - claims.iat <= 600);
  const ok = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(pair.publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

test("signAppJwt accepts a PEM with escaped newlines", () => {
  assert.doesNotThrow(() => signAppJwt("1", PEM.replace(/\n/g, "\\n"), START));
});

test("the installation token is fetched once and reused until near expiry", async () => {
  const clock = { now: START };
  const github = fakeGitHub(clock);
  const tokens = createInstallationTokens(
    { appId: "1", privateKey: PEM },
    { fetch: github.fetchImpl, now: () => clock.now },
  );

  assert.equal(await tokens.get(42), "token-1");
  clock.now += HOUR - REFRESH_MARGIN_MS - 1000;
  assert.equal(await tokens.get(42), "token-1");
  assert.equal(github.calls.length, 1);
  assert.equal(github.calls[0].url, "https://api.github.com/app/installations/42/access_tokens");
  assert.match(github.calls[0].authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  clock.now += 2000;
  assert.equal(await tokens.get(42), "token-2");
  assert.equal(github.calls.length, 2);
});

test("each installation has its own token, and concurrent asks share one request", async () => {
  const clock = { now: START };
  const github = fakeGitHub(clock);
  const tokens = createInstallationTokens(
    { appId: "1", privateKey: PEM },
    { fetch: github.fetchImpl, now: () => clock.now },
  );
  const [a, b] = await Promise.all([tokens.get(1), tokens.get(1)]);
  assert.equal(a, b);
  assert.equal(await tokens.get(2), "token-2");
  assert.equal(github.calls.length, 2);
});

test("forget drops the cached token", async () => {
  const clock = { now: START };
  const github = fakeGitHub(clock);
  const tokens = createInstallationTokens(
    { appId: "1", privateKey: PEM },
    { fetch: github.fetchImpl, now: () => clock.now },
  );
  await tokens.get(7);
  tokens.forget(7);
  assert.equal(await tokens.get(7), "token-2");
});

test("a failed token request throws without the response body, and is not cached", async () => {
  let status = 401;
  const fetchImpl = (async () =>
    new Response(
      status === 201
        ? JSON.stringify({ token: "ok", expires_at: new Date(START + HOUR).toISOString() })
        : "body detail",
      { status },
    )) as typeof fetch;
  const tokens = createInstallationTokens(
    { appId: "1", privateKey: PEM },
    { fetch: fetchImpl, now: () => START },
  );
  await assert.rejects(
    tokens.get(9),
    (error: Error) => error.message.includes("401") && !error.message.includes("body detail"),
  );
  status = 201;
  assert.equal(await tokens.get(9), "ok");
});
