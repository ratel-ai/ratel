import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleProject, uniqueProjectSlug } from "./create-project";

const ORG = { id: "22222222-2222-4222-8222-222222222222", slug: "acme", limitOverrides: null };

function deps(
  projects: { slug: string; isDemo?: boolean }[] = [],
  limits: { maxProjects?: number } = {},
) {
  const created: { organizationId: string; name: string; slug: string }[] = [];
  return {
    created,
    deps: {
      organization: async () => ({ ...ORG, limitOverrides: limits }),
      listProjects: async () => projects,
      createProject: async (input: { organizationId: string; name: string; slug: string }) => {
        created.push(input);
        return { id: "44444444-4444-4444-8444-444444444444" };
      },
    },
  };
}

test("slugs follow the name and never collide inside the organization", () => {
  assert.equal(uniqueProjectSlug("Support Bot", []), "support-bot");
  assert.equal(uniqueProjectSlug("Support Bot", ["support-bot"]), "support-bot-2");
  assert.equal(uniqueProjectSlug("Support Bot", ["support-bot", "support-bot-2"]), "support-bot-3");
  assert.equal(uniqueProjectSlug("!!!", []), "project");
});

test("a project is created in the session organization with the trimmed name", async () => {
  const { created, deps: d } = deps([{ slug: "support-bot" }]);
  const result = await createConsoleProject("acme", "  Support Bot ", d);
  assert.deepEqual(result, { ok: true, projectId: "44444444-4444-4444-8444-444444444444" });
  assert.deepEqual(created, [
    { organizationId: ORG.id, name: "Support Bot", slug: "support-bot-2" },
  ]);
});

test("another organization's slug, a bad name or a full plan creates nothing", async () => {
  const other = deps();
  assert.equal((await createConsoleProject("other", "X", other.deps)).ok, false);
  const blank = deps();
  assert.equal((await createConsoleProject("acme", "  ", blank.deps)).ok, false);
  const full = deps([{ slug: "a" }], { maxProjects: 1 });
  const refused = await createConsoleProject("acme", "B", full.deps);
  assert.equal(refused.ok, false);
  const demoOnly = deps([{ slug: "demo", isDemo: true }], { maxProjects: 1 });
  assert.equal((await createConsoleProject("acme", "B", demoOnly.deps)).ok, true);
  assert.deepEqual([...other.created, ...blank.created, ...full.created], []);
});
