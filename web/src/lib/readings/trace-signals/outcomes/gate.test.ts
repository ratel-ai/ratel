import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, resolveConfig } from "@/config";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  SENTIMENT_ANALYSIS_FLAG,
  sentimentAnalysisEnabled,
  sentimentOrganizationIds,
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

test("Sentiment analysis follows the core's sentimentAnalysis switch, per organization", async () => {
  assert.equal(SENTIMENT_ANALYSIS_FLAG, "sentimentAnalysis");
  assert.ok((CORE_FLAGS as readonly string[]).includes(SENTIMENT_ANALYSIS_FLAG));
  const { deps, asked } = recordingDeps(new Set(["org_on"]));
  const ids = await sentimentOrganizationIds(
    [{ id: "org_on" }, { id: "org_off" }],
    { actor: "user_1" },
    deps,
  );
  assert.deepEqual(ids, ["org_on"]);
  assert.deepEqual([...new Set(asked.map(([flag]) => flag))], ["sentimentAnalysis"]);
  assert.deepEqual(asked[0]?.[1], { organizationId: "org_on", actor: "user_1" });
});

test("the flag is off by default: with nothing set nothing is on, and the configuration turns it on", async () => {
  const organization = { id: "org_on" };
  assert.equal(await sentimentAnalysisEnabled(organization, oss(NOTHING_SET)), false);
  assert.deepEqual(await sentimentOrganizationIds([organization], {}, oss(NOTHING_SET)), []);
  const forced = resolveConfig({ override: { flags: { sentimentAnalysis: true } } });
  assert.equal(await sentimentAnalysisEnabled(organization, oss(forced)), true);
  assert.deepEqual(await sentimentOrganizationIds([organization], {}, oss(forced)), ["org_on"]);
  // Another switch does not turn it on.
  const other = resolveConfig({ override: { flags: { toolRunInsights: true } } });
  assert.equal(await sentimentAnalysisEnabled(organization, oss(other)), false);
});

test("with an edition's flags port a forced value comes first, and a failed decision is off", async () => {
  const organization = { id: "org_on" };
  const forcedOff = resolveConfig({ override: { flags: { sentimentAnalysis: false } } });
  const off = recordingDeps(new Set(["org_on"]), forcedOff);
  assert.equal(await sentimentAnalysisEnabled(organization, off.deps), false);
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
  assert.equal(await sentimentAnalysisEnabled(organization, failing), false);
  assert.deepEqual(await sentimentOrganizationIds([organization], {}, failing), []);
});
