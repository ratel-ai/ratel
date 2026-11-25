import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { sealedSecretsKey, sealSecret, unsealSecret } from "./sealed-secrets";

const KEY = Buffer.alloc(32, 7);
const OWNER = { projectId: "p1", name: "OPENAI_API_KEY" };

test("a sealed value opens for its project and name, and never holds the clear text", () => {
  const sealed = sealSecret(KEY, OWNER, "sk-clear-é");
  assert.equal(unsealSecret(KEY, OWNER, sealed), "sk-clear-é");
  assert.ok(!sealed.includes("sk-clear"));
  assert.ok(!Buffer.from(sealed.split(".")[2] ?? "", "base64").includes("sk-clear"));
});

test("sealing one value two times gives two different texts", () => {
  assert.notEqual(sealSecret(KEY, OWNER, "v"), sealSecret(KEY, OWNER, "v"));
});

test("another project, another name or another key does not open it", () => {
  const sealed = sealSecret(KEY, OWNER, "v");
  assert.throws(() => unsealSecret(KEY, { ...OWNER, projectId: "p2" }, sealed), /does not open/);
  assert.throws(() => unsealSecret(KEY, { ...OWNER, name: "OTHER" }, sealed), /does not open/);
  assert.throws(() => unsealSecret(Buffer.alloc(32, 8), OWNER, sealed), /does not open/);
});

test("the project and the name are bound apart: moving a character between them fails", () => {
  const sealed = sealSecret(KEY, { projectId: "ab", name: "c" }, "v");
  assert.throws(() => unsealSecret(KEY, { projectId: "a", name: "bc" }, sealed), /does not open/);
});

test("a changed byte anywhere fails", () => {
  const [version, nonce = "", body = ""] = sealSecret(KEY, OWNER, "value").split(".");
  for (const [index, part] of [nonce, body].entries()) {
    const bytes = Buffer.from(part, "base64");
    for (let i = 0; i < bytes.length; i++) {
      const changed = Buffer.from(bytes);
      changed[i] = (changed[i] ?? 0) ^ 1;
      const text = changed.toString("base64");
      const sealed = index === 0 ? `${version}.${text}.${body}` : `${version}.${nonce}.${text}`;
      assert.throws(() => unsealSecret(KEY, OWNER, sealed), /does not open/);
    }
  }
});

test("text that is not a sealed value is refused", () => {
  for (const text of ["", "v", "v1.a.b", "v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA=="]) {
    assert.throws(() => unsealSecret(KEY, OWNER, text), /sealed value|does not open/);
  }
});

test("a missing key reports not configured and does not throw at boot", () => {
  assert.deepEqual(sealedSecretsKey(resolveConfig()), {
    ok: false,
    reason: "not_configured",
    message: "SANDBOX_SECRETS_KEY is not configured.",
  });
});

test("a malformed key is reported without its value", () => {
  const result = sealedSecretsKey(
    resolveConfig({ env: { SANDBOX_SECRETS_KEY: "too-short-private" } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid");
    assert.ok(!result.message.includes("too-short-private"));
  }
});

test("32 random bytes in base64 are a key, and a Terraform placeholder is not one", () => {
  const env = { SANDBOX_SECRETS_KEY: KEY.toString("base64") };
  const result = sealedSecretsKey(resolveConfig({ env }));
  assert.ok(result.ok && result.key.equals(KEY));
  const placeholder = resolveConfig({ env: { SANDBOX_SECRETS_KEY: "REPLACE_ME" } });
  assert.deepEqual(sealedSecretsKey(placeholder).ok, false);
});
