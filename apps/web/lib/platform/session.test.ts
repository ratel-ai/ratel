import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActingAs, Principal } from "@/lib/contracts/session";
import type { MembershipView } from "@/lib/platform/identity/queries";
import type { Organization, User } from "@/lib/platform/identity/schema";
import { loadSessionContext, resolveSessionContext, type SessionDeps } from "./session";

const principal: Principal = {
  id: "local-operator",
  email: "operator@ratel.invalid",
  emailVerified: true,
  name: "Local operator",
  username: "local-operator",
  avatarUrl: null,
};

function org(id: string, slug: string): Organization {
  return {
    id,
    name: slug,
    slug,
    limitOverrides: null,
    demoProjectSeededAt: null,
    createdAt: new Date(0),
  };
}

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    externalId: principal.id,
    username: "local-operator",
    email: principal.email,
    name: principal.name,
    avatarUrl: null,
    currentOrganizationId: null,
    lastProjectId: null,
    onboardingTourStatus: null,
    createdAt: new Date(0),
    ...over,
  };
}

/** In-memory deps that record what the bridge did. */
function deps(state: {
  memberships: MembershipView[];
  user?: User;
  actingAs?: ActingAs;
  organizations?: Organization[];
  organizationName?: string;
}) {
  const calls: string[] = [];
  const events: string[] = [];
  const d: SessionDeps = {
    resolvePrincipal: async () => principal,
    actingAs: async () => state.actingAs ?? null,
    upsertUser: async (input) => {
      calls.push(`upsert:${input.externalId}`);
      return state.user ?? user();
    },
    listMemberships: async () => state.memberships,
    organizationName: () => state.organizationName ?? null,
    ensurePersonalOrganization: async ({ preferredSlug, name }) => {
      calls.push(`provision:${preferredSlug}`);
      const organization = { ...org("o-new", preferredSlug), name };
      state.memberships = [{ organization, role: "admin" }];
      return { organization, role: "admin", created: true };
    },
    setCurrentOrganization: async (_userId, organizationId) => {
      calls.push(`point:${organizationId}`);
    },
    getOrganizationById: async (id) => state.organizations?.find((o) => o.id === id) ?? null,
    getUserById: async (id) => (state.user?.id === id ? state.user : null),
    trackProductEvent: async (event) => {
      events.push(event);
    },
  };
  return { d, calls, events };
}

test("a first sign-in upserts the user, provisions a personal organization and reports it once", async () => {
  const state = { memberships: [] as MembershipView[] };
  const { d, calls, events } = deps(state);

  const first = await loadSessionContext(d);
  assert.equal(first?.organization.slug, "local-operator");
  assert.equal(first?.role, "admin");
  assert.equal(first?.user.currentOrganizationId, "o-new");
  assert.deepEqual(calls, ["upsert:local-operator", "provision:local-operator"]);
  assert.deepEqual(events, ["organization_created"]);

  const second = await loadSessionContext(d);
  assert.equal(second?.organization.id, "o-new");
  assert.deepEqual(events, ["organization_created"], "a reused organization is not reported again");
});

test("a configured organization name names the organization when it is created", async () => {
  const { d, calls } = deps({ memberships: [], organizationName: "Acme & Sons" });

  const context = await loadSessionContext(d);
  assert.equal(context?.organization.name, "Acme & Sons");
  assert.equal(context?.organization.slug, "acme-sons");
  assert.deepEqual(calls, ["upsert:local-operator", "provision:acme-sons"]);
});

test("a configured organization name does not rename an organization that exists", async () => {
  const existing = org("o-1", "renamed-in-settings");
  const { d, calls } = deps({
    memberships: [{ organization: existing, role: "admin" }],
    user: user({ currentOrganizationId: "o-1" }),
    organizationName: "Acme",
  });

  const context = await loadSessionContext(d);
  assert.equal(context?.organization.name, "renamed-in-settings");
  assert.deepEqual(calls, ["upsert:local-operator"]);
});

test("a configured name with no usable slug characters still gets a slug", async () => {
  const { d } = deps({ memberships: [], organizationName: "株式会社" });

  const context = await loadSessionContext(d);
  assert.equal(context?.organization.name, "株式会社");
  assert.equal(context?.organization.slug, "org");
});

test("a stale active-organization pointer heals to the first membership and is persisted", async () => {
  const a = org("o-a", "a");
  const b = org("o-b", "b");
  const state = {
    memberships: [
      { organization: a, role: "member" as const },
      { organization: b, role: "admin" as const },
    ],
    user: user({ currentOrganizationId: "o-gone" }),
  };
  const { d, calls } = deps(state);

  const resolved = await resolveSessionContext(d);
  assert.equal(resolved?.organization.id, "o-a");
  assert.equal(resolved?.role, "member");
  assert.equal(resolved?.user.currentOrganizationId, "o-a");
  assert.ok(calls.includes("point:o-a"));

  state.user = user({ currentOrganizationId: "o-b" });
  const pointed = await resolveSessionContext(d);
  assert.equal(pointed?.organization.id, "o-b");
  assert.equal(pointed?.role, "admin");
});

test("no principal means no session", async () => {
  const { d } = deps({ memberships: [] });
  d.resolvePrincipal = async () => null;
  assert.equal(await loadSessionContext(d), null);
});

test("acting as an organization pins it on the operator's own context without writes or events", async () => {
  const own = org("o-own", "own");
  const target = org("o-target", "target");
  const state = {
    memberships: [{ organization: own, role: "admin" as const }],
    user: user({ currentOrganizationId: "o-own" }),
    organizations: [target],
    actingAs: { kind: "organization" as const, targetId: "o-target", readOnly: true },
  };
  const { d, events } = deps(state);

  const context = await loadSessionContext(d);
  assert.equal(context?.organization.id, "o-target");
  assert.equal(context?.role, "member", "a read-only session acts as a member");
  assert.equal(context?.user.id, "u1");
  assert.deepEqual(events, []);
});
