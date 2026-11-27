import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getConfig } from "@/config";
import { sandboxProvider } from "../adapters/provider-from-env";
import { BuildFailed, type SandboxProvider } from "../ports/sandbox-provider";
import { createFakeProvider } from "./fake-provider";
import { bundleInfo, tarGz } from "./support";

const VERSION_ID = "66666666-6666-4666-8666-666666666666";
// A runner that stays alive, so the tests can stop it.
const BUNDLE = tarGz([
  { name: "src/agent.ts", body: "export default () => 1;" },
  { name: ".ratel-sandbox-runner/run.js", body: "setInterval(() => {}, 1000);" },
]);

const request = (over: { install?: string[]; sha256?: string } = {}) => {
  const lines: string[] = [];
  return {
    lines,
    versionId: VERSION_ID,
    projectId: "p1",
    base: "node:24-slim",
    install: over.install ?? ["echo installed"],
    entry: "src/agent.ts",
    bundle: {
      ...bundleInfo(BUNDLE),
      ...(over.sha256 ? { sha256: over.sha256 } : {}),
      body: (async function* () {
        yield BUNDLE;
      })(),
    },
    log: (text: string) => {
      lines.push(text);
    },
  };
};

contract("fake", createFakeProvider(), {});
// The real provider, when this process is set up for it. It costs a few cents.
const real = sandboxProvider(getConfig());
contract("real", real, { skip: real ? false : "the provider is not set up", timeout: 300_000 });

function contract(
  label: string,
  provider: SandboxProvider | null,
  options: { skip?: string | false; timeout?: number },
) {
  describe(`sandbox provider contract: ${label}`, options, () => {
    const target = () => provider as SandboxProvider;

    test("builds an image, runs an instance from it and stops it", async () => {
      const build = request();
      const { imageRef } = await target().buildImage(build);
      assert.ok(imageRef);
      assert.match(build.lines.join(""), /install command 1 \(echo installed\)/);
      const start = {
        runId: VERSION_ID,
        projectId: "p1",
        imageRef,
        // As long as a run input may be.
        env: { RATEL_RUN_INPUT: "x".repeat(90_000), MODEL_KEY: "test" },
        timeoutS: 120,
      };
      const first = await target().startInstance(start);
      const second = await target().startInstance(start);
      assert.notEqual(first.instanceRef, second.instanceRef, "each start is a new instance");
      assert.deepEqual(await target().status(first.instanceRef), { state: "running" });
      for (const { instanceRef } of [first, second]) {
        await target().stopInstance(instanceRef);
        assert.equal((await stopped(target(), instanceRef)).state, "stopped");
        await target().stopInstance(instanceRef);
      }
    });

    test("a wrong bundle hash fails the build", async () => {
      const wrong = request({ sha256: "0".repeat(64) });
      await assert.rejects(target().buildImage(wrong), BuildFailed);
    });

    test("a failed install command fails the build with its number", async () => {
      const build = request({ install: ["true", "exit 3"] });
      await assert.rejects(target().buildImage(build), (error: unknown) => {
        assert.ok(error instanceof BuildFailed);
        assert.match(error.message, /install command 2 \(exit 3\) failed with exit code 3/);
        assert.doesNotMatch(error.message, /modal/i);
        return true;
      });
    });

    test("an instance that is not there reads as stopped", async () => {
      const status = await target().status("sb-01M88R5F5351N6JCSEZP1F9499");
      assert.equal(status.state, "stopped");
    });
  });
}

async function stopped(provider: SandboxProvider, instanceRef: string) {
  for (let i = 0; i < 60; i++) {
    const status = await provider.status(instanceRef);
    if (status.state === "stopped") return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the instance did not stop");
}
