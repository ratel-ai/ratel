import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActingAs } from "@/lib/contracts/session";
import type { OrgRole } from "@/lib/platform/organization";
import {
  type DeleteOrganizationDeps,
  type DeleteOrganizationSession,
  deleteConsoleOrganization,
} from "./delete-organization";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function session(role: OrgRole = "admin"): DeleteOrganizationSession {
  return {
    user: { externalId: "user_1" },
    organization: { id: ORG, name: "Acme", slug: "acme", limitOverrides: null },
    role,
  };
}

function deps(
  over: { actingAs?: ActingAs; session?: DeleteOrganizationSession | null; refusal?: string } = {},
) {
  const deleted: string[] = [];
  const events: Array<[string, unknown, unknown]> = [];
  const d: DeleteOrganizationDeps = {
    actingAs: async () => over.actingAs ?? null,
    session: async () => (over.session === undefined ? session() : over.session),
    checkDeletion: () => (over.refusal ? { ok: false, message: over.refusal } : { ok: true }),
    deleteOrganization: async (id) => {
      deleted.push(id);
    },
    track: async (event, context, properties) => {
      events.push([event, context, properties]);
    },
  };
  return { d, deleted, events };
}

test("deletes the session organization, tracks the event and answers the console entry", async () => {
  const { d, deleted, events } = deps();
  assert.deepEqual(await deleteConsoleOrganization(ORG, " Acme ", d), { ok: true, next: "/" });
  assert.deepEqual(deleted, [ORG]);
  assert.deepEqual(events, [
    ["organization_deleted", { externalId: "user_1", orgId: ORG }, { organization_slug: "acme" }],
  ]);
});

test("refused in a support session, before anything else is read", async () => {
  const { d, deleted } = deps({
    actingAs: { kind: "organization", targetId: ORG, readOnly: false },
    session: null,
  });
  assert.deepEqual(await deleteConsoleOrganization(ORG, "Acme", d), {
    ok: false,
    error: "Not available during an admin support session. End the session first.",
  });
  assert.deepEqual(deleted, []);
});

test("refused without a session", async () => {
  const { d } = deps({ session: null });
  assert.deepEqual(await deleteConsoleOrganization(ORG, "Acme", d), {
    ok: false,
    error: "Your session has expired. Sign in again.",
  });
});

test("refused for a member, and for an organization that is not the session's", async () => {
  const member = deps({ session: session("member") });
  assert.deepEqual(await deleteConsoleOrganization(ORG, "Acme", member.d), {
    ok: false,
    error: "Only organization admins can delete it.",
  });
  const other = deps();
  assert.deepEqual(await deleteConsoleOrganization(OTHER, "Acme", other.d), {
    ok: false,
    error: "Only organization admins can delete it.",
  });
  assert.deepEqual([...member.deleted, ...other.deleted], []);
});

test("refused with the entitlements port's own message", async () => {
  const { d, deleted } = deps({
    refusal: "Cancel the organization's subscription before deleting it.",
  });
  assert.deepEqual(await deleteConsoleOrganization(ORG, "Acme", d), {
    ok: false,
    error: "Cancel the organization's subscription before deleting it.",
  });
  assert.deepEqual(deleted, []);
});

test("a wrong name deletes nothing and tracks nothing", async () => {
  const { d, deleted, events } = deps();
  assert.deepEqual(await deleteConsoleOrganization(ORG, "acme", d), {
    ok: false,
    error: "The name you typed doesn't match this organization.",
  });
  assert.deepEqual(deleted, []);
  assert.deepEqual(events, []);
});
