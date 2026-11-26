import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "@/lib/platform/logger";
import { type SealedSecretsKey, unsealSecret } from "@/lib/platform/sealed-secrets";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import {
  handleListSecrets,
  handleRemoveSecret,
  handleSetSecret,
  type SecretsApiDeps,
} from "../secrets-api";
import { createSandboxDb, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

const KEY = Buffer.alloc(32, 5);
const VALUE = "clear-value-92f1c7";

async function setup() {
  const { db, client } = await createSandboxDb();
  const store = createDrizzleSecretStore(db);
  const deps = (over: Partial<SecretsApiDeps> & { role?: string; member?: string } = {}) => {
    const { role = "admin", member = PROJECT_ID, ...rest } = over;
    return {
      getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
      findProjectScope: async (projectId: string) =>
        projectId === member
          ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role }
          : null,
      enabled: async () => true,
      isRestricted: async () => false,
      secrets: () => store,
      sealingKey: (): SealedSecretsKey => ({ ok: true, key: KEY }),
      ...rest,
    };
  };
  const texts: string[] = [];
  const keep = async (response: Promise<Response>) => {
    const answer = await response;
    const text = await answer.text();
    texts.push(text);
    return { status: answer.status, body: JSON.parse(text) };
  };
  const set = (name: string, value: unknown = VALUE, over = deps(), projectId = PROJECT_ID) =>
    keep(
      handleSetSecret(
        new Request("http://x", { method: "PUT", body: JSON.stringify({ value }) }),
        projectId,
        name,
        over,
      ),
    );
  const list = (over = deps(), projectId = PROJECT_ID) => keep(handleListSecrets(projectId, over));
  const remove = (name: string, over = deps(), projectId = PROJECT_ID) =>
    keep(handleRemoveSecret(projectId, name, over));
  return { client, store, deps, set, list, remove, texts };
}

test("set, list and delete work, and no response or log line has a value", async () => {
  const t = await setup();
  const logged: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: { write: (line: string) => void logged.push(line) },
  });
  const deps = t.deps({ logger });
  assert.equal((await t.set("OPENAI_API_KEY", VALUE, deps)).status, 200);
  assert.equal((await t.set("B_KEY", `${VALUE}-b`, deps)).status, 200);
  const { body } = await t.list();
  assert.deepEqual(
    body.secrets.map((secret: object) => Object.keys(secret).sort()),
    [
      ["name", "updatedAt"],
      ["name", "updatedAt"],
    ],
  );
  assert.deepEqual(
    body.secrets.map((secret: { name: string }) => secret.name),
    ["B_KEY", "OPENAI_API_KEY"],
  );
  assert.equal((await t.remove("B_KEY", deps)).status, 200);
  assert.equal((await t.remove("B_KEY", deps)).status, 404);
  assert.equal((await t.set("X_KEY", { nested: VALUE }, deps)).status, 400);
  assert.equal((await t.set("X_KEY", VALUE.repeat(5000), deps)).status, 400);
  assert.equal((await t.set("X_KEY", "", deps)).status, 400);
  assert.deepEqual(
    (await t.list()).body.secrets.map((secret: { name: string }) => secret.name),
    ["OPENAI_API_KEY"],
  );
  assert.match(logged.join(""), /sandbox secret set/, "the scan sees the log lines");
  for (const text of [...t.texts, ...logged]) assert.ok(!text.includes(VALUE), text);
});

test("the stored column does not have the clear value, and opens for its project only", async () => {
  const t = await setup();
  await t.set("OPENAI_API_KEY");
  const { rows } = await t.client.query<Record<string, unknown>>("select * from sandbox_secrets");
  assert.ok(!JSON.stringify(rows).includes(VALUE));
  assert.ok(!JSON.stringify(rows).includes(Buffer.from(VALUE).toString("base64")));
  const sealed = (await t.store.readSealed(PROJECT_ID, ["OPENAI_API_KEY", "NONE"])).get(
    "OPENAI_API_KEY",
  );
  const owner = { projectId: PROJECT_ID, name: "OPENAI_API_KEY" };
  assert.equal(unsealSecret(KEY, owner, sealed ?? ""), VALUE);
  assert.throws(() => unsealSecret(KEY, { ...owner, projectId: OTHER_PROJECT_ID }, sealed ?? ""));
  assert.equal((await t.store.readSealed(OTHER_PROJECT_ID, ["OPENAI_API_KEY"])).size, 0);
});

test("a second set replaces the value", async () => {
  const t = await setup();
  await t.set("A_KEY", "first-value");
  await t.set("A_KEY", "second-value");
  const sealed = (await t.store.readSealed(PROJECT_ID, ["A_KEY"])).get("A_KEY") ?? "";
  assert.equal(unsealSecret(KEY, { projectId: PROJECT_ID, name: "A_KEY" }, sealed), "second-value");
});

test("a reserved prefix and a name that is not one are refused", async () => {
  const t = await setup();
  for (const name of ["RATEL_URL", "BOAT_API_KEY", "AWS_REGION", "lower", "A-B", "1A", ""]) {
    assert.equal((await t.set(name)).status, 400, name);
  }
  assert.match((await t.set("RATEL_URL")).body.message, /reserved/);
});

test("a write in a support session is refused with the standard message", async () => {
  const t = await setup();
  const restricted = t.deps({ isRestricted: async () => true });
  for (const refused of [
    await t.set("A_KEY", VALUE, restricted),
    await t.remove("A_KEY", restricted),
  ]) {
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, SUPPORT_SESSION_RESTRICTED_MESSAGE);
  }
  assert.equal((await t.list(restricted)).status, 200);
});

test("a member of another organization gets no access", async () => {
  const t = await setup();
  await t.set("A_KEY");
  const outsider = t.deps({ member: OTHER_PROJECT_ID });
  assert.equal((await t.list(outsider)).status, 404);
  assert.equal((await t.set("B_KEY", VALUE, outsider)).status, 404);
  assert.equal((await t.remove("A_KEY", outsider)).status, 404);
  assert.equal((await t.list()).body.secrets.length, 1);
  assert.equal((await t.list(t.deps({ getSession: async () => null }))).status, 401);
});

test("a member who is not an admin reads the names and changes nothing", async () => {
  const t = await setup();
  const member = t.deps({ role: "member" });
  assert.equal((await t.set("A_KEY", VALUE, member)).status, 403);
  assert.equal((await t.remove("A_KEY", member)).status, 403);
  assert.equal((await t.list(member)).status, 200);
});

test("with no sealing key a set says not configured, and with the flag off all is 404", async () => {
  const t = await setup();
  const keyless = t.deps({
    sealingKey: () => ({ ok: false, reason: "not_configured", message: "It is not configured." }),
  });
  const refused = await t.set("A_KEY", VALUE, keyless);
  assert.deepEqual([refused.status, refused.body.error], [503, "not_configured"]);
  const off = t.deps({ enabled: async () => false });
  assert.equal((await t.list(off)).status, 404);
  assert.equal((await t.set("A_KEY", VALUE, off)).status, 404);
  assert.equal((await t.remove("A_KEY", off)).status, 404);
});
