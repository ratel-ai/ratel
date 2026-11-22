import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  SANDBOXES_FLAG,
  sandboxesEnabledForOrganization,
  sandboxesEnabledForProject,
  sandboxesOn,
} from "@/lib/platform/sandboxes-flag";

const PROJECT = { projectId: "p1" };
const oss = (env: Record<string, string>) => ({ env, edition: "Ratel OSS", port: undefined });

/** A Cloud flags port that answers `answer` and records what it was asked. */
function cloudPort(answer: boolean | Error) {
  const asked: [CoreFlag, FlagSubject][] = [];
  const port = {
    async enabled(flag: CoreFlag, subject: FlagSubject) {
      asked.push([flag, subject]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { asked, port };
}

const cloud = (env: Record<string, string>, port: ReturnType<typeof cloudPort>["port"]) => ({
  env,
  edition: "Ratel Cloud",
  port,
});

test("FF_SANDBOXES is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(SANDBOXES_FLAG, "FF_SANDBOXES");
  assert.ok((CORE_FLAGS as readonly string[]).includes(SANDBOXES_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await sandboxesOn(PROJECT, oss({})), false);
});

test("OSS: FF_SANDBOXES turns sandboxes on, and only a true value does", async () => {
  assert.equal(await sandboxesOn(PROJECT, oss({ FF_SANDBOXES: "1" })), true);
  assert.equal(await sandboxesOn(PROJECT, oss({ FF_SANDBOXES: "true" })), true);
  assert.equal(await sandboxesOn(PROJECT, oss({ FF_SANDBOXES: "0" })), false);
  assert.equal(await sandboxesOn(PROJECT, oss({ FF_SANDBOXES: "yes" })), false);
});

test("OSS: RATEL_EXPERIMENTAL_FEATURES turns sandboxes on; another switch does not", async () => {
  assert.equal(await sandboxesOn(PROJECT, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await sandboxesOn(PROJECT, oss({ FF_TYPED_STEPS: "1" })), false);
});

test("Cloud: the flags port decides it for the project, on and off", async () => {
  const on = cloudPort(true);
  assert.equal(await sandboxesOn(PROJECT, cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [["FF_SANDBOXES", PROJECT]]);

  const off = cloudPort(false);
  assert.equal(await sandboxesOn(PROJECT, cloud({}, off.port)), false);
});

test("Cloud: an FF_SANDBOXES value set by the operator comes first", async () => {
  const off = cloudPort(false);
  assert.equal(await sandboxesOn(PROJECT, cloud({ FF_SANDBOXES: "1" }, off.port)), true);
  assert.deepEqual(off.asked, []);

  const on = cloudPort(true);
  assert.equal(await sandboxesOn(PROJECT, cloud({ FF_SANDBOXES: "0" }, on.port)), false);
});

test("Cloud: a failed decision is off", async () => {
  const failing = cloudPort(new Error("flag service down"));
  assert.equal(await sandboxesOn(PROJECT, cloud({}, failing.port)), false);
});

test("upstream's names: the organization is the subject's when the caller holds it", async () => {
  const on = cloudPort(true);
  const deps = cloud({}, on.port);
  assert.equal(await sandboxesEnabledForOrganization("p1", { id: "o1" }, deps), true);
  assert.equal(await sandboxesEnabledForOrganization("p2", null, deps), true);
  assert.equal(await sandboxesEnabledForProject("p3", deps), true);
  assert.deepEqual(on.asked, [
    ["FF_SANDBOXES", { projectId: "p1", organizationId: "o1" }],
    ["FF_SANDBOXES", { projectId: "p2" }],
    ["FF_SANDBOXES", { projectId: "p3" }],
  ]);
});

test("upstream's names: off with nothing set, on with FF_SANDBOXES", async () => {
  assert.equal(await sandboxesEnabledForProject("p1", oss({})), false);
  assert.equal(await sandboxesEnabledForOrganization("p1", { id: "o1" }, oss({})), false);
  assert.equal(await sandboxesEnabledForProject("p1", oss({ FF_SANDBOXES: "1" })), true);
});
