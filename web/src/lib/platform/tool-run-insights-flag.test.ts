import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import { TOOL_RUN_INSIGHTS_FLAG, toolRunInsightsOn } from "@/lib/platform/tool-run-insights-flag";

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
  edition: "Ratel",
  port,
});

test("FF_TOOL_RUN_INSIGHTS is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(TOOL_RUN_INSIGHTS_FLAG, "FF_TOOL_RUN_INSIGHTS");
  assert.ok((CORE_FLAGS as readonly string[]).includes(TOOL_RUN_INSIGHTS_FLAG));
});

test("OSS: off with nothing set", async () => {
  assert.equal(await toolRunInsightsOn(PROJECT, oss({})), false);
});

test("OSS: FF_TOOL_RUN_INSIGHTS turns them on, and only a true value does", async () => {
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ FF_TOOL_RUN_INSIGHTS: "1" })), true);
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ FF_TOOL_RUN_INSIGHTS: "true" })), true);
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ FF_TOOL_RUN_INSIGHTS: "0" })), false);
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ FF_TOOL_RUN_INSIGHTS: "yes" })), false);
});

test("OSS: RATEL_EXPERIMENTAL_FEATURES turns them on; another switch does not", async () => {
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await toolRunInsightsOn(PROJECT, oss({ FF_MCP_APPS: "1" })), false);
});

test("Cloud: the flags port decides it for the project, on and off", async () => {
  const on = cloudPort(true);
  assert.equal(await toolRunInsightsOn(PROJECT, cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [["FF_TOOL_RUN_INSIGHTS", PROJECT]]);

  const off = cloudPort(false);
  assert.equal(await toolRunInsightsOn(PROJECT, cloud({}, off.port)), false);
});

test("Cloud: an FF_TOOL_RUN_INSIGHTS value set by the operator comes first", async () => {
  const off = cloudPort(false);
  assert.equal(
    await toolRunInsightsOn(PROJECT, cloud({ FF_TOOL_RUN_INSIGHTS: "1" }, off.port)),
    true,
  );
  assert.deepEqual(off.asked, []);

  const on = cloudPort(true);
  assert.equal(
    await toolRunInsightsOn(PROJECT, cloud({ FF_TOOL_RUN_INSIGHTS: "0" }, on.port)),
    false,
  );
});

test("Cloud: a failed decision is off", async () => {
  const failing = cloudPort(new Error("flag service down"));
  assert.equal(await toolRunInsightsOn(PROJECT, cloud({}, failing.port)), false);
});
