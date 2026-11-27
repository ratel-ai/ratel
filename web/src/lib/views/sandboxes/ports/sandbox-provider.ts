import type { BundleInfo } from "@/lib/contracts/bundle-store";

/**
 * The service that builds images and runs instances. The developer never sees which one it is, so
 * no message of `BuildFailed` names it.
 */
export interface SandboxProvider {
  /**
   * Builds an image from the base, the bundle and the install commands. The image reference stays
   * valid. Throws `BuildFailed` when the version cannot build, any other error when the service
   * did not work.
   */
  buildImage(request: BuildRequest): Promise<{ imageRef: string }>;
  /** Starts one new instance that runs the sandbox runner and exits. */
  startInstance(request: StartRequest): Promise<{ instanceRef: string }>;
  /** Stops an instance. An instance that is not there is stopped. */
  stopInstance(instanceRef: string): Promise<void>;
  status(instanceRef: string): Promise<InstanceStatus>;
}

export type BuildRequest = {
  versionId: string;
  projectId: string;
  base: string;
  install: readonly string[];
  entry: string;
  bundle: BundleInfo & { body: AsyncIterable<Uint8Array> };
  /** Takes the output of the build, in pieces. */
  log: (text: string) => void;
};

export type StartRequest = {
  runId: string;
  projectId: string;
  imageRef: string;
  /** Every variable of the instance. All of them are kept as secret. */
  env: Readonly<Record<string, string>>;
  timeoutS: number;
};

export type InstanceStatus =
  | { state: "running" }
  | {
      state: "stopped";
      reason: "exited" | "stopped" | "timeout" | "not_found";
      exitCode: number | null;
    };

/** The version cannot build. The message is for the developer. */
export class BuildFailed extends Error {}
