import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  FINE_TUNING_FLAG,
  type FlagFailureDeps,
  fineTuningEnabled,
  fineTuningEnabledForActor,
  fineTuningEnabledWithoutOrganization,
  fineTuningOrganizationIds,
} from "../flag";

/**
 * Owned (ADR-0030): upstream's `cloud-fine-tuning` is the core switch `FF_FINE_TUNING`, off by
 * default. RC-1137's rail case keeps upstream's assertions: a decision that throws keeps
 * Fine-tuning out of the rail, and is logged and reported, never hidden.
 */

const ACME = { id: "org-1", name: "Acme", slug: "acme" };
const oss = (env: Record<string, string>) => ({ env, edition: "Ratel OSS", port: undefined });

/** A Cloud flags port that answers `answer` and records what it was asked. */
function cloud(answer: boolean | Error, env: Record<string, string> = {}) {
  const asked: [CoreFlag, FlagSubject][] = [];
  const port = {
    async enabled(flag: CoreFlag, subject: FlagSubject) {
      asked.push([flag, subject]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { asked, deps: { env, edition: "Ratel Cloud", port } };
}

test("FF_FINE_TUNING is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(FINE_TUNING_FLAG, "FF_FINE_TUNING");
  assert.ok((CORE_FLAGS as readonly string[]).includes(FINE_TUNING_FLAG));
});

test("OSS: off with nothing set; FF_FINE_TUNING or RATEL_EXPERIMENTAL_FEATURES turns it on", async () => {
  assert.equal(await fineTuningEnabled(ACME, oss({})), false);
  assert.equal(await fineTuningEnabledForActor("p1", "project:p1", oss({})), false);
  assert.equal(fineTuningEnabledWithoutOrganization({}, "Ratel OSS"), false);
  assert.equal(await fineTuningEnabled(ACME, oss({ FF_FINE_TUNING: "1" })), true);
  assert.equal(
    await fineTuningEnabledForActor("p1", "project:p1", oss({ FF_FINE_TUNING: "1" })),
    true,
  );
  assert.equal(fineTuningEnabledWithoutOrganization({ FF_FINE_TUNING: "1" }, "Ratel OSS"), true);
  assert.equal(await fineTuningEnabled(ACME, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await fineTuningEnabled(ACME, oss({ FF_PIVOTS: "1" })), false);
});

test("Cloud: the port decides in the project's organization, for the person or a caller with no session", async () => {
  const on = cloud(true);
  assert.equal(await fineTuningEnabled(ACME, on.deps, "user_1"), true);
  assert.equal(await fineTuningEnabledForActor("p1", "system:fine-tuning-build", on.deps), true);
  assert.deepEqual(on.asked, [
    ["FF_FINE_TUNING", { organizationId: "org-1", actor: "user_1" }],
    ["FF_FINE_TUNING", { projectId: "p1", actor: "system:fine-tuning-build" }],
  ]);
  assert.equal(await fineTuningEnabled(ACME, cloud(false).deps), false);
});

test("Cloud: an operator's FF_FINE_TUNING comes first; a failed decision is off", async () => {
  const off = cloud(false, { FF_FINE_TUNING: "1" });
  assert.equal(await fineTuningEnabledForActor("p1", "project:p1", off.deps), true);
  assert.deepEqual(off.asked, []);
  assert.equal(await fineTuningEnabled(ACME, cloud(new Error("down")).deps), false);
});

test("a decision that throws: off, one error logged with err, one exception reported", async () => {
  const failure = new Error("flags unreadable");
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const reported: { error: unknown; properties: Record<string, unknown> }[] = [];
  const failures: FlagFailureDeps = {
    logError: (fields, message) => logged.push({ fields, message }),
    report: (error, properties) => reported.push({ error, properties }),
  };
  const ids = await fineTuningOrganizationIds(
    [ACME],
    async () => {
      throw failure;
    },
    failures,
  );
  assert.deepEqual(ids, []);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.fields.err, failure);
  assert.equal(logged[0]?.fields.organizationId, "org-1");
  assert.equal(logged[0]?.message, "fine tuning flag read failed");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.error, failure);
});

test("a switch that is on lists the organization and logs nothing", async () => {
  const logged: unknown[] = [];
  const failures: FlagFailureDeps = {
    logError: (fields) => logged.push(fields),
    report: () => logged.push("report"),
  };
  assert.deepEqual(await fineTuningOrganizationIds([ACME], async () => true, failures), ["org-1"]);
  assert.deepEqual(await fineTuningOrganizationIds([ACME], async () => false, failures), []);
  assert.deepEqual(logged, []);
});
