import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  SHIP_MONITOR_FLAG,
  shipMonitorEnabledFor,
  shipMonitorEnabledForActor,
} from "@/lib/views/ship-monitor/gate";

/** The ship watch's switch (`FF_SHIP_MONITOR`, upstream's `cloud-ship-monitor`), off by default. */

const ORGANIZATION = { id: "org-1" };
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

test("FF_SHIP_MONITOR is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(SHIP_MONITOR_FLAG, "FF_SHIP_MONITOR");
  assert.ok((CORE_FLAGS as readonly string[]).includes(SHIP_MONITOR_FLAG));
});

test("OSS: off with nothing set, for the page and for an MCP caller", async () => {
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, oss({})), false);
  assert.equal(await shipMonitorEnabledForActor("p1", "project:p1", oss({})), false);
});

test("OSS: FF_SHIP_MONITOR turns the watch on, and only a true value does", async () => {
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, oss({ FF_SHIP_MONITOR: "1" })), true);
  assert.equal(
    await shipMonitorEnabledForActor("p1", "project:p1", oss({ FF_SHIP_MONITOR: "true" })),
    true,
  );
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, oss({ FF_SHIP_MONITOR: "0" })), false);
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, oss({ FF_EVAL_GATE: "1" })), false);
});

test("Cloud: the flags port decides it for the organization, or for the caller and the project", async () => {
  const on = cloudPort(true);
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, cloud({}, on.port)), true);
  assert.equal(await shipMonitorEnabledForActor("p1", "user_ada", cloud({}, on.port)), true);
  assert.deepEqual(on.asked, [
    ["FF_SHIP_MONITOR", { organizationId: "org-1" }],
    ["FF_SHIP_MONITOR", { projectId: "p1", actor: "user_ada" }],
  ]);
  const off = cloudPort(false);
  assert.equal(await shipMonitorEnabledFor(ORGANIZATION, cloud({}, off.port)), false);
});

test("Cloud: an FF_SHIP_MONITOR value in the environment comes first; a failed decision is off", async () => {
  const off = cloudPort(false);
  assert.equal(
    await shipMonitorEnabledFor(ORGANIZATION, cloud({ FF_SHIP_MONITOR: "1" }, off.port)),
    true,
  );
  assert.deepEqual(off.asked, []);
  const failing = cloudPort(new Error("flags service down"));
  assert.equal(
    await shipMonitorEnabledForActor("p1", "project:p1", cloud({}, failing.port)),
    false,
  );
});
