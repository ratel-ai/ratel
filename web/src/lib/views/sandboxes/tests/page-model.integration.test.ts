import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSandboxIndex } from "../adapters/drizzle-sandbox-index";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { EVAL_TRIAL_PREFIX, type RunRequest } from "../domain/run";
import { loadSandboxDetail, loadSandboxList } from "../page-model";
import {
  bundleInfo,
  CONFIG,
  createSandboxDb,
  IMAGE,
  OTHER_PROJECT_ID,
  PROJECT_ID,
} from "./support";

const server = { configured: () => true, problems: () => [] };

async function setup() {
  const { db, client } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const runs = createDrizzleRunStore(db);
  const secrets = createDrizzleSecretStore(db);
  const push = async (name: string, secretNames: string[], projectId = PROJECT_ID) => {
    const created = await versions.create(
      {
        projectId,
        apiKeyId: null,
        config: { ...CONFIG, name, secrets: secretNames },
        image: IMAGE,
        git: { commit: "a".repeat(40), dirty: false },
        bundle: bundleInfo(Buffer.from(`${name}${secretNames.join()}${Math.random()}`)),
      },
      async () => ({ ok: true }),
    );
    assert.ok(created.ok);
    return created.version;
  };
  const ready = async (versionId: string) =>
    client.query("update sandbox_versions set status = 'ready' where id = $1", [versionId]);
  const run = async (versionId: string, requestedBy = "user_1") => {
    await ready(versionId);
    const created = await runs.create(
      {
        id: crypto.randomUUID(),
        projectId: PROJECT_ID,
        versionId,
        request: { runId: "r" } as unknown as RunRequest,
        tokenHash: crypto.randomUUID(),
        traceId: "c".repeat(32),
        timeoutS: 60,
        requestedBy,
      },
      async () => ({ ok: true }),
    );
    assert.ok(created.ok);
  };
  const deps = {
    ...server,
    index: createDrizzleSandboxIndex(db),
    versions,
    runs,
    secrets,
  };
  return { client, secrets, push, run, deps };
}

test("the list has one row a sandbox, the newest push first, with its newest version, push count and last run", async () => {
  const t = await setup();
  const first = await t.push("billing-bot", ["OPENAI_API_KEY"]);
  await t.run(first.id);
  await t.push("billing-bot", ["OPENAI_API_KEY", "STRIPE_KEY"]);
  await t.push("support-bot", ["OPENAI_API_KEY"]);
  await t.push("elsewhere", [], OTHER_PROJECT_ID);

  const model = await loadSandboxList(PROJECT_ID, true, t.deps);
  assert.deepEqual(
    model.sandboxes.map((row) => [
      row.name,
      row.versions,
      row.newest.status,
      row.lastRunAt !== null,
    ]),
    [
      ["support-bot", 1, "uploading", false],
      ["billing-bot", 2, "uploading", true],
    ],
  );
  assert.equal(model.sandboxes[1]?.href, `/project/${PROJECT_ID}/sandboxes/billing-bot`);
  assert.equal(model.sandboxes[1]?.newest.commit, "a".repeat(40));
});

test("the project secrets list each value and each declared name, with the sandboxes that declare it", async () => {
  const t = await setup();
  await t.push("billing-bot", ["OPENAI_API_KEY", "STRIPE_KEY"]);
  await t.push("support-bot", ["OPENAI_API_KEY"]);
  await t.secrets.set(PROJECT_ID, "OPENAI_API_KEY", "sealed", "u");
  await t.secrets.set(PROJECT_ID, "UNUSED_KEY", "sealed", "u");
  await t.secrets.set(PROJECT_ID, "STRIPE_KEY", "sealed", "u", "billing-bot");

  const { projectSecrets } = await loadSandboxList(PROJECT_ID, true, t.deps);
  assert.deepEqual(
    projectSecrets.map(({ name, updatedAt, declaredBy }) => [name, updatedAt !== null, declaredBy]),
    [
      ["STRIPE_KEY", false, ["billing-bot"]],
      ["OPENAI_API_KEY", true, ["billing-bot", "support-bot"]],
      ["UNUSED_KEY", true, []],
    ],
  );
  assert.ok(!JSON.stringify(projectSecrets).includes("sealed"), "no value");
});

test("one sandbox has its own versions, its own runs and the source of each declared secret", async () => {
  const t = await setup();
  const billing = await t.push("billing-bot", ["OPENAI_API_KEY", "STRIPE_KEY", "DB_URL"]);
  const support = await t.push("support-bot", ["OPENAI_API_KEY"]);
  await t.run(billing.id);
  await t.run(support.id);
  await t.run(billing.id, `${EVAL_TRIAL_PREFIX}trial-1`);
  await t.secrets.set(PROJECT_ID, "OPENAI_API_KEY", "sealed", "u");
  await t.secrets.set(PROJECT_ID, "STRIPE_KEY", "sealed", "u");
  await t.secrets.set(PROJECT_ID, "STRIPE_KEY", "sealed", "u", "billing-bot");
  await t.secrets.set(PROJECT_ID, "OLD_KEY", "sealed", "u", "billing-bot");

  const model = await loadSandboxDetail(PROJECT_ID, "billing-bot", true, t.deps);
  assert.ok(model);
  assert.deepEqual(
    model.versions.map((version) => version.id),
    [billing.id],
  );
  assert.deepEqual(
    model.runs.map((run) => run.versionId),
    [billing.id],
    "the runs of this sandbox, no eval trial",
  );
  assert.deepEqual(
    model.secrets.map(({ name, source }) => [name, source]),
    [
      ["OPENAI_API_KEY", "project"],
      ["STRIPE_KEY", "sandbox"],
      ["DB_URL", "missing"],
    ],
  );
  assert.equal(model.secrets[2]?.updatedAt, null);
  assert.deepEqual(
    model.undeclared.map(({ name }) => name),
    ["OLD_KEY"],
  );
  assert.equal(await loadSandboxDetail(PROJECT_ID, "nope", true, t.deps), null);
  assert.equal(await loadSandboxDetail(OTHER_PROJECT_ID, "billing-bot", true, t.deps), null);
});
