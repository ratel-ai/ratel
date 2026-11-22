import assert from "node:assert/strict";
import { test } from "node:test";
import { TRAINING_CONSENT_VERSION } from "@/lib/console/onboarding/training-consent";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { type ConsentApiDeps, type ConsentEvent, handleConsentRequest } from "../consent-api";
import type { TrainingConsent } from "../domain/consent";

/** RC-1123: only an organization admin gives or withdraws the training opt-in; off, the route is not found. */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;
const GIVEN_AT = new Date("2026-11-20T10:00:00.000Z");

function harness(
  overrides: Partial<ConsentApiDeps> & { role?: string; active?: TrainingConsent | null } = {},
) {
  let active: TrainingConsent | null = overrides.active ?? null;
  const tracked: ConsentEvent[] = [];
  const deletedFor: string[] = [];
  const deps: ConsentApiDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async () => ({
      project: PROJECT,
      organization: ORGANIZATION,
      role: overrides.role ?? "admin",
    }),
    fineTuningEnabled: async () => true,
    isRestricted: async () => false,
    consents: () => ({
      getActiveConsent: async () => active,
      giveConsent: async (projectId, actor, textVersion) => {
        if (active) return { consent: active, created: false };
        active = {
          id: "c1",
          projectId,
          givenBy: actor,
          givenAt: GIVEN_AT,
          textVersion,
          withdrawnBy: null,
          withdrawnAt: null,
        };
        return { consent: active, created: true };
      },
      withdrawConsent: async (_projectId, actor) => {
        if (!active) return null;
        const withdrawn = {
          ...active,
          withdrawnBy: actor,
          withdrawnAt: new Date("2026-11-21T10:00:00.000Z"),
        };
        active = null;
        return withdrawn;
      },
    }),
    datasets: () => ({
      deleteDatasets: async (projectId) => {
        deletedFor.push(projectId);
        return 0;
      },
    }),
    track: async (event) => {
      tracked.push(event);
    },
    ...overrides,
  };
  const call = (method: "GET" | "POST" | "DELETE", body?: unknown) =>
    handleConsentRequest(
      new Request("http://x/api/projects/p1/fine-tuning/consent", {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      "p1",
      deps,
    );
  return { call, tracked, deletedFor, active: () => active };
}

test("an admin gives the opt-in: the row holds the Clerk id, the time and the text version, and one event", async () => {
  const { call, tracked, active } = harness();
  const response = await call("POST", { textVersion: TRAINING_CONSENT_VERSION });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    consent: {
      active: true,
      givenBy: "user_1",
      givenAt: GIVEN_AT.toISOString(),
      textVersion: TRAINING_CONSENT_VERSION,
    },
  });
  assert.equal(active()?.givenBy, "user_1");
  assert.deepEqual(tracked, [
    {
      name: "training_consent_given",
      externalId: "user_1",
      projectId: "p1",
      organizationId: "org-1",
      textVersion: TRAINING_CONSENT_VERSION,
    },
  ]);
});

test("giving it again changes nothing and emits no event", async () => {
  const existing: TrainingConsent = {
    id: "c0",
    projectId: "p1",
    givenBy: "user_0",
    givenAt: GIVEN_AT,
    textVersion: TRAINING_CONSENT_VERSION,
    withdrawnBy: null,
    withdrawnAt: null,
  };
  const { call, tracked } = harness({ active: existing });
  const response = await call("POST", { textVersion: TRAINING_CONSENT_VERSION });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).consent.givenBy, "user_0");
  assert.deepEqual(tracked, []);
});

test("an admin withdraws it: the datasets are deleted and one event is emitted", async () => {
  const existing: TrainingConsent = {
    id: "c0",
    projectId: "p1",
    givenBy: "user_0",
    givenAt: GIVEN_AT,
    textVersion: TRAINING_CONSENT_VERSION,
    withdrawnBy: null,
    withdrawnAt: null,
  };
  const { call, tracked, deletedFor, active } = harness({ active: existing });
  const response = await call("DELETE");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    consent: { active: false, givenBy: null, givenAt: null, textVersion: null },
    datasetsDeleted: 0,
  });
  assert.equal(active(), null);
  assert.deepEqual(deletedFor, ["p1"]);
  assert.deepEqual(tracked, [
    {
      name: "training_consent_withdrawn",
      externalId: "user_1",
      projectId: "p1",
      organizationId: "org-1",
      textVersion: TRAINING_CONSENT_VERSION,
      datasetsDeleted: 0,
    },
  ]);
});

test("withdrawing with no opt-in is refused, but the datasets are still deleted", async () => {
  const { call, tracked, deletedFor } = harness();
  const response = await call("DELETE");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "not_given");
  assert.deepEqual(deletedFor, ["p1"]);
  assert.deepEqual(tracked, []);
});

test("a member reads the opt-in and the text, but cannot give or withdraw it", async () => {
  const { call, active } = harness({ role: "member" });
  const read = await call("GET");
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.consent.active, false);
  assert.equal(body.text.version, TRAINING_CONSENT_VERSION);
  assert.equal(body.canEdit, false);
  for (const method of ["POST", "DELETE"] as const) {
    const response = await call(
      method,
      method === "POST" ? { textVersion: TRAINING_CONSENT_VERSION } : undefined,
    );
    assert.equal(response.status, 403, method);
    assert.equal((await response.json()).error, "not_admin");
  }
  assert.equal(active(), null);
});

test("signed out, not a member, flag off, a support session, a stale text or a bad body change nothing", async () => {
  const cases: [Partial<ConsentApiDeps>, "GET" | "POST", unknown, number][] = [
    [{ getSession: async () => null }, "GET", undefined, 401],
    [{ findProjectScope: async () => null }, "GET", undefined, 404],
    [{ fineTuningEnabled: async () => false }, "GET", undefined, 404],
    [
      { fineTuningEnabled: async () => false },
      "POST",
      { textVersion: TRAINING_CONSENT_VERSION },
      404,
    ],
    [{ isRestricted: async () => true }, "POST", { textVersion: TRAINING_CONSENT_VERSION }, 403],
    [{}, "POST", { textVersion: "2020-01-01" }, 409],
    [{}, "POST", {}, 400],
    [{}, "POST", { textVersion: TRAINING_CONSENT_VERSION, extra: 1 }, 400],
  ];
  for (const [deps, method, body, status] of cases) {
    const { call, active, tracked } = harness(deps);
    assert.equal((await call(method, body)).status, status, `${method} ${JSON.stringify(body)}`);
    assert.equal(active(), null);
    assert.deepEqual(tracked, []);
  }
});

test("a store failure is not swallowed", async () => {
  const { call } = harness({
    consents: () => {
      throw new Error("database down");
    },
  });
  await assert.rejects(call("POST", { textVersion: TRAINING_CONSENT_VERSION }), /database down/);
});
