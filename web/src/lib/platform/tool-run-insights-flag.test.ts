import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, resolveConfig } from "@/config";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import { TOOL_RUN_INSIGHTS_FLAG, toolRunInsightsOn } from "@/lib/platform/tool-run-insights-flag";

const PROJECT = { projectId: "p1" };
const NOTHING_SET = resolveConfig();
const oss = (config: Config) => ({ config, edition: "Ratel OSS", port: undefined });

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

const cloud = (config: Config, port: ReturnType<typeof cloudPort>["port"]) => ({
  config,
  edition: "Ratel",
  port,
});

test("toolRunInsights is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(TOOL_RUN_INSIGHTS_FLAG, "toolRunInsights");
  assert.ok((CORE_FLAGS as readonly string[]).includes(TOOL_RUN_INSIGHTS_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await toolRunInsightsOn(PROJECT, oss(NOTHING_SET)), false);
});

test("OSS: toolRunInsights turns them on, and only on", async () => {
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      oss(resolveConfig({ override: { flags: { toolRunInsights: true } } })),
    ),
    true,
  );
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      oss(resolveConfig({ override: { flags: { toolRunInsights: false } } })),
    ),
    false,
  );
});

test("OSS: experimentalFeatures turns them on; another switch does not", async () => {
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      oss(resolveConfig({ override: { experimentalFeatures: true } })),
    ),
    true,
  );
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      oss(resolveConfig({ override: { flags: { mcpApps: true } } })),
    ),
    false,
  );
});

test("Cloud: the flags port decides it for the project, on and off", async () => {
  const on = cloudPort(true);
  assert.equal(await toolRunInsightsOn(PROJECT, cloud(NOTHING_SET, on.port)), true);
  assert.deepEqual(on.asked, [["toolRunInsights", PROJECT]]);

  const off = cloudPort(false);
  assert.equal(await toolRunInsightsOn(PROJECT, cloud(NOTHING_SET, off.port)), false);
});

test("Cloud: a toolRunInsights value the operator forced comes first", async () => {
  const off = cloudPort(false);
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      cloud(resolveConfig({ override: { flags: { toolRunInsights: true } } }), off.port),
    ),
    true,
  );
  assert.deepEqual(off.asked, []);

  const on = cloudPort(true);
  assert.equal(
    await toolRunInsightsOn(
      PROJECT,
      cloud(resolveConfig({ override: { flags: { toolRunInsights: false } } }), on.port),
    ),
    false,
  );
});

test("Cloud: a failed decision is off", async () => {
  const failing = cloudPort(new Error("flag service down"));
  assert.equal(await toolRunInsightsOn(PROJECT, cloud(NOTHING_SET, failing.port)), false);
});
