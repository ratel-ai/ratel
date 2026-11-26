import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runContainer } from "../container-run";
import type { RatelYaml } from "../domain/config";
import { startVmSession } from "../vm-session";
import { scriptAgent } from "./fake-agent";
import { createFakeProvider } from "./fake-provider";
import { CONFIG } from "./support";

const COMMAND_CONFIG = {
  ...CONFIG,
  run: { mode: "command", command: ["node", "agent.js", "it's"], timeoutSeconds: 60 },
} satisfies RatelYaml;

for (const config of [CONFIG, COMMAND_CONFIG] as RatelYaml[]) {
  test(`each command of a ${config.run?.mode} run is valid shell syntax`, async () => {
    const provider = createFakeProvider();
    scriptAgent(provider);
    const vm = await startVmSession(provider, {
      projectId: "p1",
      purpose: "run",
      ttlS: 60,
      labels: {},
      network: { inbound: "closed", outbound: { mode: "deny" } },
      keepSnapshots: false,
    });
    await runContainer(vm, {
      name: "run-1",
      filePrefix: "/tmp/ratel-run-1-",
      config,
      tag: "ratel-agent:1",
      secrets: {},
      request: {},
      timeoutS: 30,
    });
    assert.ok(provider.execs.length > 1);
    for (const { command } of provider.execs) {
      // `bash -n` reads the command and runs nothing.
      const checked = spawnSync("bash", ["-n", "-c", command]);
      assert.equal(checked.status, 0, `${command}\n${checked.stderr.toString()}`);
    }
  });
}
