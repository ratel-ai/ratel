import assert from "node:assert/strict";
import { test } from "node:test";
import { signSandboxToken, verifySandboxToken } from "../domain/token";

const SECRET = "s".repeat(44);
const NOW = new Date("2026-11-20T10:00:00Z");
const CLAIMS = { projectId: "p1", organizationId: "o1", ownerUserId: "user_1", apiKeyId: "k1" };

test("a signed token verifies with its claims and expires in 15 minutes", () => {
  const { token, expiresAt } = signSandboxToken(CLAIMS, SECRET, NOW);
  assert.equal(expiresAt.toISOString(), "2026-11-20T10:15:00.000Z");
  const verified = verifySandboxToken(token, SECRET, new Date("2026-11-20T10:14:59Z"));
  assert.ok(verified.ok);
  assert.equal(verified.claims.ownerUserId, "user_1");
  assert.equal(verified.claims.projectId, "p1");
  assert.deepEqual(verifySandboxToken(token, SECRET, expiresAt), { ok: false, reason: "expired" });
});

test("a token with another secret, changed claims or a bad shape is refused", () => {
  const { token } = signSandboxToken(CLAIMS, SECRET, NOW);
  assert.deepEqual(verifySandboxToken(token, "t".repeat(44), NOW), {
    ok: false,
    reason: "bad_signature",
  });
  const [, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ v: 1, ...CLAIMS, ownerUserId: "user_2", iat: 0, exp: 9e9 }),
  ).toString("base64url");
  assert.deepEqual(verifySandboxToken(`${forged}.${sig}`, SECRET, NOW), {
    ok: false,
    reason: "bad_signature",
  });
  assert.deepEqual(verifySandboxToken("nodot", SECRET, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifySandboxToken(`${token}.x`, SECRET, NOW), {
    ok: false,
    reason: "malformed",
  });
});

test("a short secret is refused", () => {
  assert.throws(() => signSandboxToken(CLAIMS, "short", NOW), /too short/);
});
