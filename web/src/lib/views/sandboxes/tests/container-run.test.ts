import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runContainer } from "../container-run";
import type { RatelYaml } from "../domain/config";
import { MAX_RESPONSE_BYTES } from "../domain/contract";
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

// Live (RP-421): a VM from a saved snapshot is ready before Docker has loaded its images, so a
// `docker run` right after the start tried a registry pull and failed.
async function runIn(script: Parameters<typeof scriptAgent>[1], config: RatelYaml = CONFIG) {
  const provider = createFakeProvider();
  scriptAgent(provider, script);
  const vm = await startVmSession(provider, {
    projectId: "p1",
    purpose: "smoke",
    ttlS: 60,
    labels: {},
    network: { inbound: "closed", outbound: { mode: "deny" } },
    keepSnapshots: false,
  });
  const ran = await runContainer(vm, {
    name: "smoke-1",
    filePrefix: "/tmp/ratel-smoke-",
    config,
    tag: "ratel-agent:1",
    secrets: {},
    request: {},
    timeoutS: 30,
  });
  return { ran, commands: provider.execs.map((exec) => exec.command) };
}

for (const config of [CONFIG, COMMAND_CONFIG] as RatelYaml[]) {
  test(`a ${config.run?.mode} run waits for the image before it makes the container`, async () => {
    const { ran, commands } = await runIn({}, config);
    assert.equal(ran.answer.ok, true);
    const wait = commands.findIndex((c) => c.includes("docker image inspect ratel-agent:1"));
    const make = commands.findIndex((c) => /^docker (run -d|create)/.test(c));
    assert.ok(wait >= 0 && make > wait, commands.join("\n"));
  });

  test(`a ${config.run?.mode} run whose image never comes fails as no_health, with no container`, async () => {
    const { ran, commands } = await runIn({ imageMissingPolls: "never" }, config);
    assert.equal(ran.answer.ok, false);
    // The codes are the codes of the CLI: no new code for this case.
    assert.equal(!ran.answer.ok && ran.answer.error.code, "no_health");
    assert.match(!ran.answer.ok ? ran.answer.error.message : "", /image .* is not in the VM/);
    assert.ok(!commands.some((c) => /^docker (run -d|create)/.test(c)), commands.join("\n"));
  });
}

test("a container that does not start names the error of Docker, not its help line", async () => {
  const startError =
    "Unable to find image 'ratel-agent:1' locally\ndocker: Error response from daemon: failed to resolve reference\n\nRun 'docker run --help' for more information\n";
  const { ran } = await runIn({ starts: false, startError });
  assert.equal(ran.answer.ok, false);
  const message = ran.answer.ok ? "" : ran.answer.error.message;
  assert.match(message, /Error response from daemon: failed to resolve reference/);
  assert.doesNotMatch(message, /--help/);
});

test("an HTTP answer over the cap is too_large, and the VM sends at most the cap", async () => {
  const body = JSON.stringify({ output: "x".repeat(MAX_RESPONSE_BYTES) });
  const { ran, commands } = await runIn({ answer: { status: 200, body } });
  assert.equal(!ran.answer.ok && ran.answer.error.code, "too_large");
  const call = commands.find((command) => command.includes("/ratel/run")) ?? "";
  assert.match(call, new RegExp(`head -c ${MAX_RESPONSE_BYTES + 1}`));
});

test("a command answer over the cap is too_large, and the VM sends at most the cap", async () => {
  const stdout = "y".repeat(MAX_RESPONSE_BYTES + 1);
  const { ran, commands } = await runIn({ command: { exitCode: 0, stdout } }, COMMAND_CONFIG);
  assert.equal(!ran.answer.ok && ran.answer.error.code, "too_large");
  const call = commands.find((command) => command.startsWith("docker create")) ?? "";
  assert.match(call, new RegExp(`head -c ${MAX_RESPONSE_BYTES + 1}`));
  // The stderr of the command (the logs) is cut on the VM too.
  assert.match(call, /tail -c \d+/);
});
