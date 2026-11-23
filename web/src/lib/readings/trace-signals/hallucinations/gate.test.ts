import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, resolveConfig } from "@/config";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import type { Organization } from "@/lib/platform/organizations";
import {
  HALLUCINATION_DETECTION_FLAG,
  hallucinationDetectionEnabled,
  hallucinationOrganizationIds,
  hallucinationReadingEnabled,
} from "./gate";

const NOTHING_SET = resolveConfig();
const oss = (config: Config) => ({ config, edition: "Ratel OSS", port: undefined });

/** An edition's flags port that is on for the organizations in `on`, and records what it was asked. */
function recordingDeps(on: ReadonlySet<string>, config: Config = NOTHING_SET) {
  const asked: [CoreFlag, FlagSubject][] = [];
  return {
    asked,
    deps: {
      config,
      edition: "Ratel",
      port: {
        async enabled(flag: CoreFlag, subject: FlagSubject) {
          asked.push([flag, subject]);
          return on.has(subject.organizationId ?? "");
        },
      },
    },
  };
}

test("hallucination detection follows the core's hallucinationDetection switch, per organization", async () => {
  assert.equal(HALLUCINATION_DETECTION_FLAG, "hallucinationDetection");
  assert.ok((CORE_FLAGS as readonly string[]).includes(HALLUCINATION_DETECTION_FLAG));
  const { deps, asked } = recordingDeps(new Set(["org_on"]));
  const ids = await hallucinationOrganizationIds(
    [{ id: "org_on" }, { id: "org_off" }],
    { actor: "user_1" },
    deps,
  );
  assert.deepEqual(ids, ["org_on"]);
  assert.deepEqual([...new Set(asked.map(([flag]) => flag))], ["hallucinationDetection"]);
  assert.deepEqual(asked[0]?.[1], { organizationId: "org_on", actor: "user_1" });
});

test("the flag is off by default: with nothing set nothing is on, and the configuration turns it on", async () => {
  const organization = { id: "org_on" };
  assert.equal(await hallucinationDetectionEnabled(organization, oss(NOTHING_SET)), false);
  assert.deepEqual(await hallucinationOrganizationIds([organization], {}, oss(NOTHING_SET)), []);
  const unset = resolveConfig({ env: {} });
  assert.equal(await hallucinationDetectionEnabled(organization, oss(unset)), false);
  const off = resolveConfig({ env: { FF_HALLUCINATION_DETECTION: "0" } });
  assert.equal(await hallucinationDetectionEnabled(organization, oss(off)), false);
  const on = resolveConfig({ env: { FF_HALLUCINATION_DETECTION: "1" } });
  assert.equal(await hallucinationDetectionEnabled(organization, oss(on)), true);
  assert.deepEqual(await hallucinationOrganizationIds([organization], {}, oss(on)), ["org_on"]);
  // Another switch does not turn it on.
  const other = resolveConfig({ override: { flags: { sentimentAnalysis: true } } });
  assert.equal(await hallucinationDetectionEnabled(organization, oss(other)), false);
});

test("with an edition's flags port a forced value comes first, and a failed decision is off", async () => {
  const organization = { id: "org_on" };
  const forcedOff = resolveConfig({ override: { flags: { hallucinationDetection: false } } });
  const off = recordingDeps(new Set(["org_on"]), forcedOff);
  assert.equal(await hallucinationDetectionEnabled(organization, off.deps), false);
  assert.equal(off.asked.length, 0);
  const failing = {
    config: NOTHING_SET,
    edition: "Ratel",
    port: {
      async enabled(): Promise<boolean> {
        throw new Error("flags down");
      },
    },
  };
  assert.equal(await hallucinationDetectionEnabled(organization, failing), false);
  assert.deepEqual(await hallucinationOrganizationIds([organization], {}, failing), []);
});

test("the reading's switch is the project's organization; no organization is off", async () => {
  const { deps, asked } = recordingDeps(new Set(["org_on"]));
  const organizationOf = (id: string) => ({ id, slug: id }) as unknown as Organization;
  const read = (id: string | null) =>
    hallucinationReadingEnabled("p1", {
      getOrganization: async () => (id ? organizationOf(id) : null),
      flags: deps,
    });
  assert.deepEqual(
    [await read("org_on"), await read("org_off"), await read(null)],
    [true, false, false],
  );
  // A background job has no signed-in person: the project is the identity and only the organization is sent.
  assert.deepEqual(asked[0]?.[1], {
    organizationId: "org_on",
    projectId: "p1",
    actor: "project:p1",
  });
  assert.equal(asked.length, 2);
});

test("the reading follows FF_HALLUCINATION_DETECTION when no edition decides it", async () => {
  const read = (env: Record<string, string>) =>
    hallucinationReadingEnabled("p1", {
      getOrganization: async () => ({ id: "org_on" }),
      flags: oss(resolveConfig({ env })),
    });
  assert.deepEqual(
    [
      await read({}),
      await read({ FF_HALLUCINATION_DETECTION: "0" }),
      await read({ FF_HALLUCINATION_DETECTION: "1" }),
    ],
    [false, false, true],
  );
});
