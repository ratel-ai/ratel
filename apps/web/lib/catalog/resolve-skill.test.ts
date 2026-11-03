import assert from "node:assert/strict";
import { test } from "node:test";
import { type ResolveSkillDeps, resolveSkill } from "@/lib/catalog/http";
import type { Skill } from "@/lib/catalog/schema";

const SKILL_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
/** The organization that owns the skill's project. */
const OWNER_ORG = "11111111-1111-4111-8111-111111111111";
/** The organization the session pointer happens to name. */
const ACTIVE_ORG = "22222222-2222-4222-8222-222222222222";

const skill = { id: SKILL_ID, name: "review-pull-request" } as Skill;

function session(memberOf: string[]) {
  return (async () => ({
    user: { id: USER_ID, externalId: "user_abc" },
    organization: { id: ACTIVE_ORG },
    memberships: memberOf.map((id) => ({ organization: { id }, role: "member" })),
  })) as unknown as ResolveSkillDeps["getSessionContext"];
}

function deps(over: Partial<ResolveSkillDeps> = {}): ResolveSkillDeps {
  return {
    getSessionContext: session([ACTIVE_ORG, OWNER_ORG]),
    getSkillWithOrganizationId: (async () => ({
      skill,
      organizationId: OWNER_ORG,
    })) as unknown as ResolveSkillDeps["getSkillWithOrganizationId"],
    ...over,
  };
}

test("a skill resolves from an organization the caller belongs to but is not active in", async () => {
  // The regression this pins: the scoped project pages authorize on membership,
  // so opening a project whose organization is not the session's active pointer
  // works, and then every save 404'd, because this resolver used the pointer.
  const resolved = await resolveSkill(SKILL_ID, deps());
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.skill.id, SKILL_ID);
  // The owning organization is what gets logged, not the stale pointer.
  assert.equal(resolved.ok && resolved.accountId, OWNER_ORG);
  assert.equal(resolved.ok && resolved.externalId, "user_abc");
});

test("membership is checked against the skill's own organization", async () => {
  const activeOnly = await resolveSkill(
    SKILL_ID,
    deps({ getSessionContext: session([ACTIVE_ORG]) }),
  );
  assert.equal(activeOnly.ok, false);
});

test("a non-member gets the same 404 as a missing skill", async () => {
  // Identical responses on purpose: a distinct 403 would confirm that an id
  // exists in some organization the caller cannot see.
  const nonMember = await resolveSkill(
    SKILL_ID,
    deps({
      getSessionContext: session([]),
    }),
  );
  const missing = await resolveSkill(
    SKILL_ID,
    deps({
      getSkillWithOrganizationId: (async () =>
        null) as unknown as ResolveSkillDeps["getSkillWithOrganizationId"],
    }),
  );

  assert.equal(nonMember.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(nonMember.ok === false && nonMember.response.status, 404);
  assert.equal(missing.ok === false && missing.response.status, 404);
  assert.deepEqual(
    nonMember.ok === false && (await nonMember.response.json()),
    missing.ok === false && (await missing.response.json()),
  );
});

test("no session is a 401, not a 404", async () => {
  const resolved = await resolveSkill(
    SKILL_ID,
    deps({
      getSessionContext: (async () => null) as unknown as ResolveSkillDeps["getSessionContext"],
    }),
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.response.status, 401);
});
