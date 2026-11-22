import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import {
  type FineTuningPageDeps,
  resolveFineTuningPageContext,
  resolveFineTuningPageEntry,
} from "./context";

/** RC-1123: with `FF_FINE_TUNING` off, the Fine-tuning page is not found. */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;

function deps(flag: boolean, role = "member"): FineTuningPageDeps {
  return {
    getSessionContext: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    getProjectScope: async () => ({ project: PROJECT, organization: ORGANIZATION, role }),
    fineTuningEnabled: async () => flag,
    isDbConfigured: () => true,
    fineTuningEnabledWithoutOrganization: () => flag,
  };
}

test("flag off: the page is not found", async () => {
  await assert.rejects(resolveFineTuningPageContext("p1", deps(false, "admin")), (err: unknown) =>
    String((err as { digest?: string }).digest ?? (err as Error).message).includes("404"),
  );
});

test("flag on: a member reads, an admin may change the opt-in", async () => {
  const member = await resolveFineTuningPageContext("p1", deps(true));
  assert.equal(member.project, PROJECT);
  assert.equal(member.externalId, "user_1");
  assert.equal(member.isAdmin, false);
  assert.equal((await resolveFineTuningPageContext("p1", deps(true, "admin"))).isAdmin, true);
});

// — RC-1137: the flag is decided before the database branch ——————————————————

const isNotFound = (err: unknown) =>
  String((err as { digest?: string }).digest ?? (err as Error).message).includes("404");

function entryDeps(flag: boolean, database: boolean): FineTuningPageDeps {
  return {
    ...deps(flag, "admin"),
    isDbConfigured: () => database,
    fineTuningEnabledWithoutOrganization: () => flag,
  };
}

test("no database and the flag off: the page entry is not found", async () => {
  await assert.rejects(resolveFineTuningPageEntry("p1", entryDeps(false, false)), isNotFound);
});

test("no database and the flag on: the page entry says the database is unavailable", async () => {
  assert.deepEqual(await resolveFineTuningPageEntry("p1", entryDeps(true, false)), {
    kind: "no_database",
  });
});

test("a database: the page entry resolves the context, and the flag off is still not found", async () => {
  const entry = await resolveFineTuningPageEntry("p1", entryDeps(true, true));
  assert.equal(entry.kind === "ready" && entry.context.project, PROJECT);
  await assert.rejects(resolveFineTuningPageEntry("p1", entryDeps(false, true)), isNotFound);
});
