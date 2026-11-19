import assert from "node:assert/strict";
import { test } from "node:test";
import { createOnboardingService, type OnboardingServiceDeps } from "./core-service";
import { QUICKSTART_KEY_ENV } from "./quickstart";

const ORG = { id: "22222222-2222-4222-8222-222222222222", name: "Acme", slug: "acme" };
const INGEST = "https://app.example/v1/traces";

function harness({
  projects = [],
  quota = { ok: true } as const,
}: {
  projects?: { slug: string; isDemo?: boolean }[];
  quota?: { ok: true } | { ok: false; plan: string; limit: number; message: string };
} = {}) {
  const created: { organizationId: string; name: string; slug: string }[] = [];
  const keys: { projectId: string; keyHash: string }[] = [];
  const events: { event: string; context: unknown }[] = [];
  const quotaFor: unknown[] = [];
  const sampled: unknown[] = [];
  const deps: OnboardingServiceDeps = {
    dbConfigured: () => true,
    listProjects: async () => projects,
    createProject: async (input) => {
      created.push(input);
      return { id: "44444444-4444-4444-8444-444444444444", name: input.name, slug: input.slug };
    },
    createApiKey: async (input) => {
      keys.push(input);
      return { id: "66666666-6666-4666-8666-666666666666" };
    },
    generateApiKey: () => ({ plaintext: "rtl_plain", hash: "hash", prefix: "rtl_plai" }),
    checkQuota: (organization) => {
      quotaFor.push(organization);
      return quota;
    },
    track: async (event, context) => {
      events.push({ event, context });
    },
    ensureSampleProject: async (context) => {
      sampled.push(context);
      return "55555555-5555-4555-8555-555555555555";
    },
  };
  return { deps, service: createOnboardingService(deps), created, keys, events, quotaFor, sampled };
}

test("a name becomes a project of the organization it is handed, with its key and its snippets", async () => {
  const { service, created, keys, events, quotaFor } = harness();
  const result = await service.createFirstProject({
    name: " Support Copilot ",
    organization: ORG,
    externalId: "user_1",
    ingestUrl: INGEST,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(created, [
    { organizationId: ORG.id, name: "Support Copilot", slug: "support-copilot" },
  ]);
  assert.equal(keys.length, 1);
  assert.equal(result.id, "44444444-4444-4444-8444-444444444444");
  assert.equal(result.slug, "support-copilot");
  assert.equal(result.apiKey, "rtl_plain");
  // No edition keeps keys here: the copy says the key is shown once.
  assert.equal(result.revealable, false);

  // The snippets are data, so the edition renders them without importing the builders.
  assert.equal(result.quickstart.keyEnv, QUICKSTART_KEY_ENV);
  assert.match(result.quickstart.install ?? "", /@ratel-ai\//);
  assert.deepEqual(
    result.quickstart.samples.map((sample) => sample.label),
    ["TypeScript", "curl"],
  );
  for (const sample of result.quickstart.samples) {
    assert.ok(sample.code.includes(INGEST), sample.label);
    assert.ok(!sample.code.includes("rtl_plain"), "no snippet inlines the key");
  }
  assert.ok(result.quickstart.samples[0]?.code.includes("support-copilot"));

  // The plan's cap is checked against the organization as handed over, and the events name the person.
  assert.equal(quotaFor[0], ORG);
  assert.deepEqual(
    events.map((entry) => entry.event),
    ["project_created", "api_key_created"],
  );
  assert.deepEqual(events[0]?.context, {
    externalId: "user_1",
    orgId: ORG.id,
    projectId: "44444444-4444-4444-8444-444444444444",
  });
});

test("a refusal comes back as it is, and nothing is created", async () => {
  const short = harness();
  assert.deepEqual(
    await short.service.createFirstProject({
      name: "a",
      organization: ORG,
      externalId: "user_1",
      ingestUrl: INGEST,
    }),
    { ok: false, error: "Give your agent a name (at least 2 characters)." },
  );
  assert.deepEqual(short.created, []);

  const capped = harness({
    projects: [{ slug: "one" }],
    quota: { ok: false, plan: "free", limit: 1, message: "Your plan allows 1 project." },
  });
  assert.deepEqual(
    await capped.service.createFirstProject({
      name: "Second",
      organization: ORG,
      externalId: "user_1",
      ingestUrl: INGEST,
    }),
    { ok: false, error: "Your plan allows 1 project." },
  );
  assert.deepEqual(capped.created, []);
  assert.deepEqual(
    capped.events.map((entry) => entry.event),
    ["quota_limit_hit"],
  );
});

test("the sample project is asked for with the organization and the person, and answers nothing", async () => {
  const { service, sampled } = harness();
  const answer = await service.ensureSampleProject({ organization: ORG, externalId: "user_1" });
  assert.equal(answer, undefined);
  assert.deepEqual(sampled, [{ organization: ORG, externalId: "user_1" }]);
});

test("a key the edition keeps comes back marked revealable, for the welcome page's copy", async () => {
  const h = harness();
  const kept: string[] = [];
  const service = createOnboardingService({
    ...h.deps,
    keepApiKeySecret: async (keyId) => {
      kept.push(keyId);
      return true;
    },
  });
  const result = await service.createFirstProject({
    name: "Support Copilot",
    organization: ORG,
    externalId: "user_1",
    ingestUrl: INGEST,
  });
  assert.deepEqual(kept, ["66666666-6666-4666-8666-666666666666"]);
  assert.equal(result.ok && result.revealable, true);
});
