import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  createPivotsEnabledLookup,
  PIVOTS_FLAG,
  pivotsEnabled,
  pivotsOn,
} from "@/lib/platform/pivots-flag";

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

test("FF_PIVOTS is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(PIVOTS_FLAG, "FF_PIVOTS");
  assert.ok((CORE_FLAGS as readonly string[]).includes(PIVOTS_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await pivotsOn(PROJECT, oss({})), false);
  assert.equal(await pivotsEnabled("p1", null, oss({})), false);
});

test("OSS: FF_PIVOTS turns pivots on, and only a true value does", async () => {
  assert.equal(await pivotsOn(PROJECT, oss({ FF_PIVOTS: "1" })), true);
  assert.equal(await pivotsOn(PROJECT, oss({ FF_PIVOTS: "true" })), true);
  assert.equal(await pivotsOn(PROJECT, oss({ FF_PIVOTS: "0" })), false);
  assert.equal(await pivotsOn(PROJECT, oss({ FF_PIVOTS: "yes" })), false);
});

test("OSS: RATEL_EXPERIMENTAL_FEATURES turns pivots on; another switch does not", async () => {
  assert.equal(await pivotsOn(PROJECT, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await pivotsOn(PROJECT, oss({ FF_TYPED_STEPS: "1" })), false);
});

test("Cloud: the flags port decides it for the project and its organization", async () => {
  const on = cloudPort(true);
  assert.equal(await pivotsEnabled("p1", { id: "org-1" }, cloud({}, on.port)), true);
  assert.equal(await pivotsEnabled("p1", null, cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [
    ["FF_PIVOTS", { projectId: "p1", organizationId: "org-1" }],
    ["FF_PIVOTS", { projectId: "p1" }],
  ]);

  const off = cloudPort(false);
  assert.equal(await pivotsOn(PROJECT, cloud({}, off.port)), false);
});

test("Cloud: an FF_PIVOTS value set by the operator comes first", async () => {
  const off = cloudPort(false);
  assert.equal(await pivotsOn(PROJECT, cloud({ FF_PIVOTS: "1" }, off.port)), true);
  assert.deepEqual(off.asked, []);

  const on = cloudPort(true);
  assert.equal(await pivotsOn(PROJECT, cloud({ FF_PIVOTS: "0" }, on.port)), false);
});

test("Cloud: a failed decision is off", async () => {
  const failing = cloudPort(new Error("flag service down"));
  assert.equal(await pivotsOn(PROJECT, cloud({}, failing.port)), false);
});

// RC-968: the sweep and the refill ask the switch per project through one cached lookup.

test("the lookup: one decision per project a minute, shared while in flight", async () => {
  let clock = 0;
  const flags = cloudPort(true);
  const lookup = createPivotsEnabledLookup({
    flag: cloud({}, flags.port),
    ttlMs: 60_000,
    now: () => clock,
  });
  assert.deepEqual(await Promise.all([lookup("p1"), lookup("p1"), lookup("p2")]), [
    true,
    true,
    true,
  ]);
  clock = 59_999;
  await lookup("p1");
  const asked = () => flags.asked.map(([, subject]) => subject.projectId);
  assert.deepEqual(asked(), ["p1", "p2"]);
  clock = 60_000;
  await lookup("p1");
  assert.deepEqual(asked(), ["p1", "p2", "p1"]);
});

test("the lookup: off with nothing set in the open-source edition, on with FF_PIVOTS", async () => {
  assert.equal(await createPivotsEnabledLookup({ flag: oss({}) })("p1"), false);
  assert.equal(await createPivotsEnabledLookup({ flag: oss({ FF_PIVOTS: "1" }) })("p1"), true);
});

test("the lookup: a failed decision is off and is not kept", async () => {
  let fail = true;
  const lookup = createPivotsEnabledLookup({
    decide: async () => {
      if (fail) throw new Error("flag service down");
      return true;
    },
  });
  assert.equal(await lookup("p1"), false);
  fail = false;
  assert.equal(await lookup("p1"), true);
});
