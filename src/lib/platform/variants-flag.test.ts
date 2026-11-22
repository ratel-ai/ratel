import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  VARIANT_EXPERIMENTS_FLAG,
  variantExperimentsEnabled,
  variantExperimentsOn,
} from "@/lib/platform/variants-flag";

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

test("FF_VARIANT_EXPERIMENTS is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(VARIANT_EXPERIMENTS_FLAG, "FF_VARIANT_EXPERIMENTS");
  assert.ok((CORE_FLAGS as readonly string[]).includes(VARIANT_EXPERIMENTS_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await variantExperimentsOn(PROJECT, oss({})), false);
  assert.equal(await variantExperimentsEnabled("p1", null, oss({})), false);
});

test("OSS: FF_VARIANT_EXPERIMENTS turns variants on, and only a true value does", async () => {
  assert.equal(await variantExperimentsOn(PROJECT, oss({ FF_VARIANT_EXPERIMENTS: "1" })), true);
  assert.equal(await variantExperimentsOn(PROJECT, oss({ FF_VARIANT_EXPERIMENTS: "true" })), true);
  assert.equal(await variantExperimentsOn(PROJECT, oss({ FF_VARIANT_EXPERIMENTS: "0" })), false);
  assert.equal(await variantExperimentsOn(PROJECT, oss({ FF_VARIANT_EXPERIMENTS: "yes" })), false);
});

test("OSS: RATEL_EXPERIMENTAL_FEATURES turns variants on; another switch does not", async () => {
  assert.equal(
    await variantExperimentsOn(PROJECT, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })),
    true,
  );
  assert.equal(await variantExperimentsOn(PROJECT, oss({ FF_PIVOTS: "1" })), false);
});

test("Cloud: the flags port decides it for the project and its organization", async () => {
  const on = cloudPort(true);
  assert.equal(await variantExperimentsEnabled("p1", { id: "org-1" }, cloud({}, on.port)), true);
  assert.equal(await variantExperimentsEnabled("p1", null, cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [
    ["FF_VARIANT_EXPERIMENTS", { projectId: "p1", organizationId: "org-1" }],
    ["FF_VARIANT_EXPERIMENTS", { projectId: "p1" }],
  ]);
  const off = cloudPort(false);
  assert.equal(await variantExperimentsEnabled("p1", { id: "org-1" }, cloud({}, off.port)), false);
});

test("Cloud: an FF_VARIANT_EXPERIMENTS value in the environment comes first", async () => {
  const off = cloudPort(false);
  assert.equal(
    await variantExperimentsEnabled("p1", null, cloud({ FF_VARIANT_EXPERIMENTS: "1" }, off.port)),
    true,
  );
});

test("a failed decision is off and never throws", async () => {
  const broken = cloudPort(new Error("flags service down"));
  assert.equal(
    await variantExperimentsEnabled("p1", { id: "org-1" }, cloud({}, broken.port)),
    false,
  );
});
