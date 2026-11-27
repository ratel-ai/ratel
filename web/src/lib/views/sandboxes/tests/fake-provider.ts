import { createHash, randomUUID } from "node:crypto";
import {
  BuildFailed,
  type BuildRequest,
  type InstanceStatus,
  type SandboxProvider,
  type StartRequest,
} from "../ports/sandbox-provider";

export type FakeProvider = SandboxProvider & {
  builds: BuildRequest[];
  starts: StartRequest[];
  stops: string[];
  /** The instances that run. */
  running: Set<string>;
  /** Ends an instance by itself. */
  exit(instanceRef: string, exitCode?: number): void;
};

/** An in-memory provider. It keeps the rules of the port that the contract test checks. */
export function createFakeProvider(): FakeProvider {
  const images = new Set<string>();
  const ended = new Map<string, InstanceStatus>();
  const fake: FakeProvider = {
    builds: [],
    starts: [],
    stops: [],
    running: new Set(),
    exit(instanceRef, exitCode = 0) {
      fake.running.delete(instanceRef);
      ended.set(instanceRef, { state: "stopped", reason: "exited", exitCode });
    },
    async buildImage(request) {
      fake.builds.push(request);
      const hash = createHash("sha256");
      for await (const chunk of request.bundle.body) hash.update(chunk);
      if (hash.digest("hex") !== request.bundle.sha256) {
        throw new BuildFailed("checking the bundle failed with exit code 1.");
      }
      for (const [index, command] of request.install.entries()) {
        request.log(`> install command ${index + 1} (${command})\n`);
        if (command === "exit 3") {
          request.log("no luck\n");
          throw new BuildFailed(
            `install command ${index + 1} (${command}) failed with exit code 3.`,
          );
        }
      }
      const imageRef = `im-${randomUUID()}`;
      images.add(imageRef);
      return { imageRef };
    },
    async startInstance(request) {
      if (!images.has(request.imageRef)) throw new Error("no such image");
      fake.starts.push(request);
      const instanceRef = `sb-${randomUUID()}`;
      fake.running.add(instanceRef);
      return { instanceRef };
    },
    async stopInstance(instanceRef) {
      fake.stops.push(instanceRef);
      if (fake.running.delete(instanceRef)) {
        ended.set(instanceRef, { state: "stopped", reason: "stopped", exitCode: 137 });
      }
    },
    async status(instanceRef) {
      if (fake.running.has(instanceRef)) return { state: "running" };
      return ended.get(instanceRef) ?? { state: "stopped", reason: "not_found", exitCode: null };
    },
  };
  return fake;
}
