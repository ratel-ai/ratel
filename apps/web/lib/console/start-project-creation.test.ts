import assert from "node:assert/strict";
import { test } from "node:test";
import { type StartProjectCreationDeps, startProjectCreation } from "./start-project-creation";

const ORG = { id: "22222222-2222-4222-8222-222222222222", slug: "acme", limitOverrides: null };

function harness(
  projects: { isDemo?: boolean }[] = [],
  limits: { maxProjects?: number } | null = null,
  session = true,
) {
  const refusals: { organizationId: string; cap: number }[] = [];
  const deps: StartProjectCreationDeps = {
    organization: async () => (session ? { ...ORG, limitOverrides: limits } : null),
    listProjects: async () => projects,
    onRefused: async (organization, capacity) => {
      refusals.push({ organizationId: organization.id, cap: capacity.limit });
    },
  };
  return { deps, refusals };
}

test("New project opens onboarding for the organization, as upstream does", async () => {
  const h = harness([{}, { isDemo: true }]);
  assert.deepEqual(await startProjectCreation("acme", h.deps), {
    redirect: "/onboarding?organization=acme",
  });
  assert.deepEqual(h.refusals, []);
});

test("at the plan's cap it returns to the projects page with the reason, and reports the refusal", async () => {
  const h = harness([{}, { isDemo: true }], { maxProjects: 1 });
  assert.deepEqual(await startProjectCreation("acme", h.deps), {
    redirect: "/org/acme?limit=projects",
  });
  assert.deepEqual(h.refusals, [{ organizationId: ORG.id, cap: 1 }]);
});

test("the demo project does not count toward the cap", async () => {
  const h = harness([{ isDemo: true }], { maxProjects: 1 });
  assert.deepEqual(await startProjectCreation("acme", h.deps), {
    redirect: "/onboarding?organization=acme",
  });
});

test("another organization's slug is not found; no session goes home", async () => {
  assert.deepEqual(await startProjectCreation("globex", harness().deps), { notFound: true });
  assert.deepEqual(await startProjectCreation("acme", harness([], null, false).deps), {
    redirect: "/",
  });
});
