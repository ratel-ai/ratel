import assert from "node:assert/strict";
import { test } from "node:test";
import { runContainer } from "../container-run";
import type { StartVmRequest } from "../ports/sandbox-provider";
import { attachVmSession, SnapshotRefused, startVmSession } from "../vm-session";
import { scriptAgent } from "./fake-agent";
import { createFakeProvider } from "./fake-provider";
import { CONFIG } from "./support";

const PREPARE: StartVmRequest = {
  projectId: "p1",
  purpose: "prepare",
  ttlS: 60,
  labels: {},
  network: { inbound: "open", outbound: { mode: "open" } },
  keepSnapshots: true,
};
const SECRET = "sk-session-secret-17"; // gitleaks:allow (fake test value)

test("a VM that got no secret is saved as a snapshot", async () => {
  const provider = createFakeProvider();
  const vm = await startVmSession(provider, PREPARE);
  await vm.writeFile({ path: "/home/user/image.tar", body: Buffer.from("x"), size: 1 });
  await vm.exec({ command: "true", timeoutS: 5 });
  assert.equal(vm.secretFree, true);
  assert.deepEqual(await vm.saveSnapshot("rv-1"), { snapshotRef: "rv-1" });
  assert.ok(provider.snapshots.has("rv-1"));
});

test("a VM that got a secret file refuses a snapshot, and the provider gets no call", async () => {
  const provider = createFakeProvider();
  const vm = await startVmSession(provider, PREPARE);
  const body = Buffer.from(`KEY=${SECRET}\n`);
  await vm.writeSecretFile({ path: "/tmp/env", body, size: body.length });
  // The file is gone, but the VM got the secret: no cleanup makes it free again.
  await vm.exec({ command: "rm -f /tmp/env", timeoutS: 5 });
  assert.equal(vm.secretFree, false);
  await assert.rejects(vm.saveSnapshot("rv-1"), SnapshotRefused);
  assert.equal(provider.snapshots.size, 0);
});

test("a write of a secret file that fails still marks the VM", async () => {
  const provider = createFakeProvider();
  const vm = await startVmSession(provider, PREPARE);
  provider.writeFile = async () => {
    throw new Error("lost");
  };
  const body = Buffer.from(`KEY=${SECRET}\n`);
  await assert.rejects(vm.writeSecretFile({ path: "/tmp/env", body, size: body.length }));
  await assert.rejects(vm.saveSnapshot("rv-1"), SnapshotRefused);
});

test("a container run marks the VM, also one with no secret value", async () => {
  for (const secrets of [{ OPENAI_API_KEY: SECRET }, {}] as Record<string, string>[]) {
    const provider = createFakeProvider();
    scriptAgent(provider);
    const vm = await startVmSession(provider, PREPARE);
    await runContainer(vm, {
      name: "smoke-1",
      filePrefix: "/tmp/ratel-smoke-",
      config: CONFIG,
      tag: "ratel-agent:1",
      secrets,
      request: {},
      timeoutS: 30,
    });
    assert.equal(provider.vms.get(vm.vmRef)?.files.size, 0, "the run removed its files");
    await assert.rejects(vm.saveSnapshot("rv-1"), SnapshotRefused);
    assert.equal(provider.snapshots.size, 0);
  }
});

test("a VM that this session did not start refuses a snapshot: its past is not known", async () => {
  const provider = createFakeProvider();
  const { vmRef } = await provider.startVm(PREPARE);
  const vm = attachVmSession(provider, vmRef);
  assert.equal(vm.secretFree, false);
  await assert.rejects(vm.saveSnapshot("rv-1"), SnapshotRefused);
  assert.equal(provider.snapshots.size, 0);
});

test("delete deletes the VM", async () => {
  const provider = createFakeProvider();
  const vm = await startVmSession(provider, PREPARE);
  await vm.delete();
  assert.deepEqual(provider.deleted, [vm.vmRef]);
});
