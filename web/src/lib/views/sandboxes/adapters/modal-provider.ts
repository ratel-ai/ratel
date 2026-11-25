import type { App, ModalClient, Sandbox } from "modal";
import { getLogger } from "@/lib/platform/logger";
import { APP_DIR, BUNDLE_PATH, buildSteps, RUN_COMMAND } from "../domain/container";
import {
  BuildFailed,
  type BuildRequest,
  type InstanceStatus,
  type SandboxProvider,
  type StartRequest,
} from "../ports/sandbox-provider";

/**
 * {@link SandboxProvider} on Modal (the `modal` SDK). A build writes the bundle into a builder
 * sandbox of the base image, runs the install commands and keeps a snapshot of its filesystem with
 * no expiry: the snapshot's image id is the image reference. No value of a variable is logged.
 */
export type ModalProviderOptions = {
  client: () => Promise<ModalClient>;
  /** The Modal App of the builds and the instances, created when it is missing. */
  appName: string;
  /** A broad Modal region, e.g. `eu`. */
  region: string;
  /** The limit of one build. */
  buildTimeoutMs?: number;
};

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
/** A write goes as one message, so a large bundle goes in parts. */
const PART_BYTES = 16 * 1024 * 1024;
/** Exit codes that Modal gives to a terminated and to a timed-out sandbox. */
const TERMINATED_EXIT = 137;
const TIMEOUT_EXIT = 124;
const GRPC_NOT_FOUND = 5;

const logger = getLogger("sandboxes/provider");

export function createModalProvider(options: ModalProviderOptions): SandboxProvider {
  let app: Promise<App> | undefined;
  const appOf = (client: ModalClient): Promise<App> => {
    app ??= client.apps.fromName(options.appName, { createIfMissing: true }).catch((error) => {
      app = undefined;
      throw error;
    });
    return app;
  };

  return {
    async buildImage(request) {
      const client = await options.client();
      const modalApp = await appOf(client);
      const base = await buildBase(client, modalApp, request.base);
      const builder = await client.sandboxes.create(modalApp, base, {
        timeoutMs: options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
        regions: [options.region],
        tags: { ratel_role: "build", ratel_version_id: request.versionId },
      });
      try {
        await writeBundle(builder, request.bundle.body);
        const { install, entry, bundle } = request;
        for (const step of buildSteps({ install, entry, sha256: bundle.sha256 })) {
          await runStep(builder, step.label, step.script, request);
        }
        const image = await builder.snapshotFilesystem({
          ttlMs: null,
          timeoutMs: SNAPSHOT_TIMEOUT_MS,
        });
        return { imageRef: image.imageId };
      } finally {
        await terminate(builder).catch((error: unknown) => {
          // The builder's own timeout still ends it.
          logger.error(
            { instance_ref: builder.sandboxId, error_type: errorType(error) },
            "builder did not stop",
          );
        });
      }
    },

    async startInstance(request: StartRequest) {
      const client = await options.client();
      const modalApp = await appOf(client);
      const [image, secret] = await Promise.all([
        client.images.fromId(request.imageRef),
        client.secrets.fromObject({ ...request.env }),
      ]);
      const sandbox = await client.sandboxes.create(modalApp, image, {
        command: RUN_COMMAND,
        workdir: APP_DIR,
        secrets: [secret],
        timeoutMs: request.timeoutS * 1000,
        regions: [options.region],
        tags: { ratel_role: "run", ratel_run_id: request.runId },
      });
      const instanceRef = sandbox.sandboxId;
      sandbox.detach();
      return { instanceRef };
    },

    async stopInstance(instanceRef) {
      const client = await options.client();
      // With no wait: a process that ignores the signal holds the call for 30 seconds.
      await unlessMissing(async () => terminate(await client.sandboxes.fromId(instanceRef)));
    },

    async status(instanceRef) {
      const client = await options.client();
      const polled = await unlessMissing(async () => {
        const sandbox = await client.sandboxes.fromId(instanceRef);
        const exitCode = await sandbox.poll();
        sandbox.detach();
        return { exitCode };
      });
      if (!polled) return { state: "stopped", reason: "not_found", exitCode: null };
      return statusOf(polled.exitCode);
    },
  };
}

/** A poll result as a status: null is running. */
export function statusOf(exitCode: number | null): InstanceStatus {
  if (exitCode === null) return { state: "running" };
  if (exitCode === TERMINATED_EXIT) return { state: "stopped", reason: "stopped", exitCode };
  if (exitCode === TIMEOUT_EXIT) return { state: "stopped", reason: "timeout", exitCode };
  return { state: "stopped", reason: "exited", exitCode };
}

async function buildBase(client: ModalClient, app: App, base: string) {
  try {
    return await client.images.fromRegistry(base).build(app);
  } catch (error) {
    logger.warn({ error_type: errorType(error) }, "base image did not load");
    throw new BuildFailed(`The base image ${base} did not load. Check its name.`);
  }
}

async function writeBundle(builder: Sandbox, body: AsyncIterable<Uint8Array>): Promise<void> {
  let part: Uint8Array[] = [];
  let bytes = 0;
  let index = 0;
  const flush = async () => {
    const name = `/tmp/ratel-part-${String(index++).padStart(6, "0")}`;
    await builder.filesystem.writeBytes(Buffer.concat(part), name);
    part = [];
    bytes = 0;
  };
  for await (const chunk of body) {
    part.push(chunk);
    bytes += chunk.length;
    if (bytes >= PART_BYTES) await flush();
  }
  if (bytes > 0) await flush();
  const proc = await builder.exec([
    "sh",
    "-c",
    `cat /tmp/ratel-part-* > ${BUNDLE_PATH} && rm -f /tmp/ratel-part-*`,
  ]);
  if ((await proc.wait()) !== 0) throw new Error("the bundle was not written");
}

async function runStep(
  builder: Sandbox,
  label: string,
  script: string,
  { log }: BuildRequest,
): Promise<void> {
  log(`> ${label}\n`);
  const proc = await builder.exec(["sh", "-c", `set -eu\n${script}`], { env: { CI: "true" } });
  const [exitCode] = await Promise.all([
    proc.wait(),
    pipe(proc.stdout, log),
    pipe(proc.stderr, log),
  ]);
  if (exitCode !== 0) throw new BuildFailed(`${label} failed with exit code ${exitCode}.`);
}

async function pipe(stream: ReadableStream<string>, log: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) log(next.value);
}

/** The result of a call on an instance, or null when the instance is not there. */
async function unlessMissing<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** The lookup makes no call, so a missing instance shows as the gRPC status of the next call. */
function isMissing(error: unknown): boolean {
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "NotFoundError" || code === GRPC_NOT_FOUND;
}

async function terminate(sandbox: Sandbox): Promise<void> {
  await sandbox.terminate();
  sandbox.detach();
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
