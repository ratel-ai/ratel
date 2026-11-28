import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { getConfig } from "@/config";
import { createBoatProvider } from "../adapters/boat-provider";
import { createLocalDockerProvider } from "../adapters/local-docker-provider";
import { sandboxDeploymentId, sandboxProvider } from "../adapters/provider-from-env";
import { snapshotName } from "../domain/snapshot-name";
import type { SandboxProvider, StartVmRequest } from "../ports/sandbox-provider";
import { type FakeBoatServer, startFakeBoatServer } from "./fake-boat-server";
import { createFakeProvider } from "./fake-provider";
import { DOCKER_SKIP, dockerAnswers } from "./support";

const RUN_ID = randomUUID();
const BASE: StartVmRequest = {
  projectId: "p1",
  purpose: "prepare",
  ttlS: 600,
  labels: { "ratel-contract": RUN_ID },
  network: { inbound: "open", outbound: { mode: "open" } },
  keepSnapshots: true,
};

contract("fake", "test-deployment", () => createFakeProvider(), {});

let server: FakeBoatServer | undefined;
before(async () => {
  server = await startFakeBoatServer();
});
after(async () => {
  await server?.close();
});
contract(
  "adapter on a fake server",
  "contract",
  () =>
    createBoatProvider({
      apiKey: "k",
      baseUrl: server?.url,
      deploymentId: "contract",
      pollMs: 1,
      inlineMaxBytes: 64,
    }),
  {},
);

// The local Docker daemon, when it answers. The first run builds the VM image.
const docker = dockerAnswers();
contract(
  "local docker",
  `contract-${RUN_ID.slice(0, 8)}`,
  () => createLocalDockerProvider({ deploymentId: `contract-${RUN_ID.slice(0, 8)}` }),
  {
    skip: docker ? false : `${DOCKER_SKIP}: local-docker contract skipped`,
    timeout: 600_000,
  },
);

// The real provider, when this process is set up for it. It costs a few cents.
const real = sandboxProvider(getConfig());
contract("real", sandboxDeploymentId(getConfig()), () => real as SandboxProvider, {
  skip: real ? false : "the provider is not set up",
  timeout: 600_000,
});

function contract(
  label: string,
  deploymentId: string,
  make: () => SandboxProvider,
  options: { skip?: string | false; timeout?: number },
) {
  describe(`sandbox provider contract: ${label}`, options, () => {
    const made: string[] = [];
    const snapshots: string[] = [];
    let provider: SandboxProvider;
    before(() => {
      provider = make();
    });
    // Each test deletes its VMs at its end: a trial account of the provider runs 2 VMs at once.
    afterEach(async () => {
      for (const vmRef of made.splice(0)) await provider.deleteVm(vmRef);
    });
    after(async () => {
      for (const name of snapshots) await provider.deleteSnapshot(name);
    });
    const start = async (request: StartVmRequest = BASE) => {
      const { vmRef } = await provider.startVm(request);
      made.push(vmRef);
      return vmRef;
    };

    test("a started VM runs commands, with their exit code and stdin", async () => {
      const vmRef = await start();
      assert.equal((await provider.vmStatus(vmRef)).state, "running");
      const echo = await provider.exec(vmRef, { command: "echo hello", timeoutS: 30 });
      assert.deepEqual([echo.exitCode, echo.stdout, echo.timedOut], [0, "hello\n", false]);
      assert.equal((await provider.exec(vmRef, { command: "exit 3", timeoutS: 30 })).exitCode, 3);
      const piped = await provider.exec(vmRef, {
        command: "cat",
        timeoutS: 30,
        stdin: "from stdin",
      });
      assert.equal(piped.stdout, "from stdin");
    });

    test("a written file is read back, small and large", async () => {
      const vmRef = await start();
      const small = Buffer.from("A=1\n");
      await provider.writeFile(vmRef, { path: "/tmp/small", body: small, size: small.length });
      const large = Buffer.alloc(200, "x");
      const body = (async function* () {
        yield large.subarray(0, 100);
        yield large.subarray(100);
      })();
      await provider.writeFile(vmRef, { path: "/home/user/large", body, size: large.length });
      const read = (path: string) => provider.exec(vmRef, { command: `cat ${path}`, timeoutS: 30 });
      assert.equal((await read("/tmp/small")).stdout, "A=1\n");
      assert.equal((await read("/home/user/large")).stdout, large.toString());
    });

    test("a VM starts from a saved snapshot with its files", async () => {
      const vmRef = await start();
      const body = Buffer.from("kept");
      await provider.writeFile(vmRef, { path: "/home/user/kept", body, size: body.length });
      const name = `rc-${RUN_ID}`;
      const { snapshotRef } = await provider.saveSnapshot(vmRef, name);
      snapshots.push(snapshotRef);
      const copy = await start({
        ...BASE,
        purpose: "run",
        fromSnapshot: snapshotRef,
        keepSnapshots: false,
        network: { inbound: "closed", outbound: { mode: "deny" } },
      });
      const read = await provider.exec(copy, { command: "cat /home/user/kept", timeoutS: 30 });
      assert.equal(read.stdout, "kept");
    });

    test("a saved snapshot of a version is listed with its version", async () => {
      const vmRef = await start();
      const versionId = randomUUID();
      const { snapshotRef } = await provider.saveSnapshot(
        vmRef,
        snapshotName(deploymentId, versionId),
      );
      snapshots.push(snapshotRef);
      const listed = await provider.listSnapshots();
      assert.ok(listed.some((s) => s.snapshotRef === snapshotRef && s.versionId === versionId));
      assert.ok(listed.every((s) => s.snapshotRef === snapshotName(deploymentId, s.versionId)));
    });

    test("VMs are listed by label, and deletes are idempotent", async () => {
      const vmRef = await start();
      const listed = await provider.listVms({ "ratel-contract": RUN_ID });
      assert.ok(listed.some((vm) => vm.vmRef === vmRef));
      await provider.deleteVm(vmRef);
      await provider.deleteVm(vmRef);
      assert.ok(["stopped", "gone"].includes((await provider.vmStatus(vmRef)).state));
      await provider.deleteSnapshot(`rc-none-${RUN_ID}`);
    });

    test("a VM that is not there is gone", async () => {
      assert.deepEqual(await provider.vmStatus("bx_zzzzzzzz"), { state: "gone" });
    });
  });
}
