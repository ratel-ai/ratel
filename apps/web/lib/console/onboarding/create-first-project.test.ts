import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActingAs } from "@/lib/contracts/session";
import {
  type CreateFirstProjectDeps,
  createFirstProject,
  SUPPORT_SESSION_RESTRICTED_MESSAGE,
} from "./create-first-project";

const ORG = { id: "22222222-2222-4222-8222-222222222222", slug: "acme", limitOverrides: null };
const USER = { externalId: "user_1" };

function harness({
  projects = [],
  quota = { ok: true } as const,
  actingAs = null,
  session = { user: USER, organization: ORG },
}: {
  projects?: { slug: string; isDemo?: boolean }[];
  quota?: { ok: true } | { ok: false; plan: string; limit: number; message: string };
  actingAs?: ActingAs;
  session?: { user: { externalId: string }; organization: typeof ORG } | null;
} = {}) {
  const created: { organizationId: string; name: string; slug: string }[] = [];
  const keys: { projectId: string; name: string; keyHash: string; keyPrefix: string }[] = [];
  const events: { event: string; context: unknown; properties: unknown }[] = [];
  let counted = -1;
  const deps: CreateFirstProjectDeps = {
    session: async () => session,
    actingAs: async () => actingAs,
    listProjects: async () => projects,
    createProject: async (input) => {
      created.push(input);
      return { id: "44444444-4444-4444-8444-444444444444", name: input.name, slug: input.slug };
    },
    createApiKey: async (input) => {
      keys.push(input);
    },
    generateApiKey: () => ({ plaintext: "rtl_secret-value", prefix: "rtl_secret-v", hash: "h" }),
    checkQuota: (_org, _key, count) => {
      counted = count;
      return quota;
    },
    track: async (event, context, properties) => {
      events.push({ event, context, properties });
    },
  };
  return { deps, created, keys, events, counted: () => counted };
}

test("the first project lands with a Default key, revealed once", async () => {
  const h = harness();
  const state = await createFirstProject({ name: " Support Copilot " }, h.deps);
  assert.deepEqual(state, {
    ok: true,
    id: "44444444-4444-4444-8444-444444444444",
    name: "Support Copilot",
    slug: "support-copilot",
    apiKey: "rtl_secret-value",
    showCaptureConsent: true,
  });
  assert.deepEqual(h.created, [
    { organizationId: ORG.id, name: "Support Copilot", slug: "support-copilot" },
  ]);
  assert.deepEqual(h.keys, [
    {
      projectId: "44444444-4444-4444-8444-444444444444",
      name: "Default",
      keyHash: "h",
      keyPrefix: "rtl_secret-v",
    },
  ]);
  assert.deepEqual(
    h.events.map((e) => [e.event, e.properties]),
    [
      ["project_created", { project_slug: "support-copilot" }],
      ["api_key_created", { key_prefix: "rtl_secret-v", named: true, expires_in: "never" }],
    ],
  );
  assert.deepEqual(h.events[1]?.context, {
    externalId: "user_1",
    orgId: ORG.id,
    projectId: "44444444-4444-4444-8444-444444444444",
  });
});

test("slugs stay unique within the organization and fall back to agent", async () => {
  const h = harness({ projects: [{ slug: "support-copilot" }, { slug: "support-copilot-2" }] });
  const state = await createFirstProject({ name: "Support Copilot" }, h.deps);
  assert.equal(state?.ok && state.slug, "support-copilot-3");
  const odd = harness();
  const fallback = await createFirstProject({ name: "!!" }, odd.deps);
  assert.equal(fallback?.ok && fallback.slug, "agent");
});

test("the name must be between 2 and 60 characters", async () => {
  const h = harness();
  assert.deepEqual(await createFirstProject({ name: " a " }, h.deps), {
    ok: false,
    error: "Give your agent a name (at least 2 characters).",
  });
  assert.deepEqual(await createFirstProject({ name: "x".repeat(61) }, h.deps), {
    ok: false,
    error: "Name is too long (max 60 characters).",
  });
  assert.deepEqual(h.created, []);
});

test("a support session cannot mint a project or a key", async () => {
  const h = harness({ actingAs: { kind: "organization", targetId: ORG.id, readOnly: false } });
  assert.deepEqual(await createFirstProject({ name: "Support Copilot" }, h.deps), {
    ok: false,
    error: SUPPORT_SESSION_RESTRICTED_MESSAGE,
  });
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.keys, []);
});

test("the plan's project cap refuses and is counted without the demo project", async () => {
  const h = harness({
    projects: [{ slug: "demo", isDemo: true }, { slug: "a" }],
    quota: { ok: false, plan: "free", limit: 1, message: "Free includes 1 project." },
  });
  assert.deepEqual(await createFirstProject({ name: "Support Copilot" }, h.deps), {
    ok: false,
    error: "Free includes 1 project.",
  });
  assert.equal(h.counted(), 1);
  assert.deepEqual(
    h.events.map((e) => [e.event, e.properties]),
    [["quota_limit_hit", { limit: "maxProjects", cap: 1 }]],
  );
  assert.deepEqual(h.created, []);
});

test("no session, or another organization's id, creates nothing", async () => {
  const signedOut = harness({ session: null });
  assert.deepEqual(await createFirstProject({ name: "Support Copilot" }, signedOut.deps), {
    ok: false,
    error: "Your session has expired. Sign in again.",
  });
  const other = harness();
  assert.deepEqual(
    await createFirstProject({ name: "Support Copilot", organizationId: "other" }, other.deps),
    { ok: false, error: "Organization not found." },
  );
  const same = harness();
  const ok = await createFirstProject(
    { name: "Support Copilot", organizationId: ORG.id },
    same.deps,
  );
  assert.equal(ok?.ok, true);
  assert.deepEqual([...signedOut.created, ...other.created], []);
});
