import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import type { BundleStore } from "@/lib/contracts/bundle-store";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getLogger } from "@/lib/platform/logger";
import { bundleKey, type SandboxVersion } from "./domain/version";
import type { BuildOutcome, BuildStore } from "./ports/build-store";
import { BuildFailed, type SandboxProvider } from "./ports/sandbox-provider";

/** The `sandbox_image_build` job: one pushed version becomes an image. */
export type ImageBuildDeps = {
  builds: BuildStore;
  bundles: BundleStore;
  provider: SandboxProvider | null;
  enabled: (projectId: string) => Promise<boolean>;
  now: () => Date;
  /** Calls `beat` again and again until the returned function is called. */
  every: (ms: number, beat: () => void) => () => void;
  /** The limit of one build. `BUILD_DEADLINE_MS` by default. */
  deadlineMs?: number;
};

export const HEARTBEAT_MS = 30_000;
/** With no heartbeat for this time the process of a build is gone. */
export const BUILD_STOPPED_MS = 5 * 60_000;
/** A little more than the provider's own limits: a call that never answers must not hold the lane. */
export const BUILD_DEADLINE_MS = 40 * 60_000;
export const NOT_CONFIGURED_REASON = "Ratel sandbox is not configured on this deployment.";
export const OFF_REASON = "Ratel sandbox is off for this project.";
export const STOPPED_REASON = "The build was interrupted. Push again.";
const TOO_LONG_REASON = "The build took too long. Push again.";
const SERVICE_REASON = "The build service did not work. Push again.";
/** The end of the log is the part that explains a failure. */
const MAX_LOG_CHARS = 64_000;
/** The end of a failed step's output that goes in the reason. */
const MAX_REASON_OUTPUT_CHARS = 2_000;
const IMAGE_PATH = "/home/user/image.tar";
const STEP_TIMEOUT_S = 600;
/** A prepare VM lives a little longer than the deadline of its build, if the job does not delete it. */
const PREPARE_GRACE_S = 300;

const payloadSchema = z.object({ versionId: z.uuid() });
const logger = getLogger("sandboxes/image-build");

export async function runImageBuild(
  projectId: string,
  payload: unknown,
  deps: ImageBuildDeps,
): Promise<{ status: string }> {
  const { versionId } = payloadSchema.parse(payload);
  const enabled = await deps.enabled(projectId);
  if (!enabled || !deps.provider) {
    const reason = enabled ? NOT_CONFIGURED_REASON : OFF_REASON;
    await deps.builds.leaveUnbuilt(projectId, versionId, reason);
    return { status: "unbuilt" };
  }
  const version = await deps.builds.claim(projectId, versionId, deps.now());
  if (!version) return { status: "skipped" };

  const stop = deps.every(HEARTBEAT_MS, () => {
    deps.builds.heartbeat(versionId, deps.now()).catch((error: unknown) => {
      logger.warn({ version_id: versionId, err: error }, "build heartbeat failed");
    });
  });
  try {
    const outcome = await build(version, deps.provider, deps);
    await deps.builds.finish(versionId, outcome, deps.now());
    logger.info(
      { project_id: projectId, version_id: versionId, outcome: outcome.status },
      "sandbox build finished",
    );
    return { status: outcome.status };
  } finally {
    stop();
  }
}

async function build(
  version: SandboxVersion,
  provider: SandboxProvider,
  { bundles, deadlineMs = BUILD_DEADLINE_MS }: ImageBuildDeps,
): Promise<BuildOutcome> {
  const { id, projectId } = version;
  const log = createLog();
  try {
    const { imageRef } = await withFeatureSpan(
      "sandboxes",
      "build_image",
      () => within(deadlineMs, prepare(version, provider, bundles, deadlineMs, log.add)),
      { attributes: { "project.id": projectId, "sandbox.version_id": id } },
    );
    return { status: "ready", imageRef, log: log.text() };
  } catch (error) {
    if (error instanceof BuildFailed) {
      return { status: "failed", reason: error.message, log: log.text() };
    }
    logger.error({ project_id: projectId, version_id: id, err: error }, "sandbox build broke");
    return { status: "failed", reason: SERVICE_REASON, log: log.text() };
  }
}

/**
 * Loads the pushed image tarball into a prepare VM, tags it and saves the VM as a snapshot: the
 * snapshot is the image reference. The VM is deleted at the end.
 */
async function prepare(
  version: SandboxVersion,
  provider: SandboxProvider,
  bundles: BundleStore,
  deadlineMs: number,
  log: (text: string) => void,
): Promise<{ imageRef: string }> {
  const { vmRef } = await provider.startVm({
    projectId: version.projectId,
    purpose: "prepare",
    ttlS: Math.ceil(deadlineMs / 1000) + PREPARE_GRACE_S,
    labels: { "ratel-version": version.id },
    network: { inbound: "open", outbound: { mode: "open" } },
    keepSnapshots: true,
  });
  try {
    log("> writing the image\n");
    const body = await bundles.open(bundleKey(version));
    if (!body) throw new BuildFailed("The bundle is not there. Push again.");
    const hash = createHash("sha256");
    await provider.writeFile(vmRef, {
      path: IMAGE_PATH,
      body: hashing(body, hash),
      size: version.bundle.bytes,
    });
    if (hash.digest("hex") !== version.bundle.sha256) {
      throw new BuildFailed("checking the bundle failed: it is not the pushed bundle. Push again.");
    }
    const loaded = await step(
      provider,
      vmRef,
      "loading the image",
      `docker load -i ${IMAGE_PATH}`,
      log,
    );
    const image = /^Loaded image(?: ID)?: (\S+)$/m.exec(loaded)?.[1];
    if (!image) throw new BuildFailed("loading the image failed: the tarball holds no image.");
    const tag = imageTag(version.id);
    await step(
      provider,
      vmRef,
      "tagging the image",
      `docker tag ${shellQuote(image)} ${tag} && rm -f ${IMAGE_PATH}`,
      log,
    );
    log("> saving the image\n");
    const { snapshotRef } = await provider.saveSnapshot(vmRef, `rv-${version.id}`);
    return { imageRef: snapshotRef };
  } finally {
    await provider.deleteVm(vmRef).catch((error: unknown) => {
      // The TTL of the VM still ends it.
      logger.warn({ version_id: version.id, err: error }, "prepare vm not deleted");
    });
  }
}

/** Runs one step of a build and logs its output. A failed step fails the build with its output. */
async function step(
  provider: SandboxProvider,
  vmRef: string,
  label: string,
  command: string,
  log: (text: string) => void,
): Promise<string> {
  log(`> ${label}\n`);
  const result = await provider.exec(vmRef, { command, timeoutS: STEP_TIMEOUT_S });
  const output = `${result.stdout}${result.stderr}`;
  log(output);
  if (result.exitCode === 0) return output;
  const why = result.timedOut ? "took too long" : `failed with exit code ${result.exitCode}`;
  throw new BuildFailed(`${label} ${why}.\n${output.slice(-MAX_REASON_OUTPUT_CHARS)}`.trimEnd());
}

/** The Docker tag of the image of a version in its VM. */
export function imageTag(versionId: string): string {
  return `ratel-agent:${versionId}`;
}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BuildFailed(TOO_LONG_REASON)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function* hashing(body: AsyncIterable<Uint8Array>, hash: Hash) {
  for await (const chunk of body) {
    hash.update(chunk);
    yield chunk;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createLog() {
  let text = "";
  let cut = false;
  return {
    add(piece: string) {
      text += piece;
      if (text.length > MAX_LOG_CHARS * 2) {
        text = text.slice(-MAX_LOG_CHARS);
        cut = true;
      }
    },
    text() {
      const short = text.length <= MAX_LOG_CHARS && !cut;
      const tail = short ? text : `[the start of the log is cut]\n${text.slice(-MAX_LOG_CHARS)}`;
      // Postgres text has no NUL.
      return tail.replaceAll("\0", "");
    },
  };
}
