import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import type { BundleStore } from "@/lib/contracts/bundle-store";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getLogger } from "@/lib/platform/logger";
import { shellQuote } from "./container-run";
import { secretNamesOf } from "./domain/config";
import type { SmokeResult } from "./domain/contract";
import { bundleKey, type SandboxVersion } from "./domain/version";
import type { BuildOutcome, BuildStore } from "./ports/build-store";
import {
  BuildFailed,
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderUnavailable,
  type SandboxProvider,
} from "./ports/sandbox-provider";
import { openSecretValues, type SecretValuesDeps } from "./secret-values";
import { runSmokeCheck, smokeLeftovers } from "./smoke-check";

/**
 * The `sandbox_image_build` job: one pushed image becomes a ready version. It loads the image in a
 * prepare VM, runs the smoke check and saves a snapshot.
 */
export type ImageBuildDeps = SecretValuesDeps & {
  builds: BuildStore;
  bundles: BundleStore;
  provider: SandboxProvider | null;
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
export const STOPPED_REASON = "The build was interrupted. Push again.";
const LEFTOVERS_REASON =
  "The VM still holds a container, a volume or a file of the smoke check, so no snapshot is saved. Push again.";
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
  if (!deps.provider) {
    await deps.builds.leaveUnbuilt(projectId, versionId, NOT_CONFIGURED_REASON);
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
  deps: ImageBuildDeps,
): Promise<BuildOutcome> {
  const { id, projectId } = version;
  const { deadlineMs = BUILD_DEADLINE_MS } = deps;
  const log = createLog();
  // The smoke result, also when the build fails after it.
  const seen: { smoke: SmokeResult | null } = { smoke: null };
  try {
    const secrets = await openSecretValues(projectId, secretNamesOf(version.config), deps);
    if (!secrets.ok) throw new BuildFailed(secrets.message);
    const imageRef = await withFeatureSpan(
      "sandboxes",
      "build_image",
      () =>
        within(
          deadlineMs,
          prepare(
            version,
            provider,
            deps.bundles,
            deadlineMs,
            secrets.values,
            log.add,
            (result) => {
              seen.smoke = result;
            },
          ),
        ),
      { attributes: { "project.id": projectId, "sandbox.version_id": id } },
    );
    if (!seen.smoke) throw new Error("a ready version has no smoke check");
    return { status: "ready", imageRef, smoke: seen.smoke, log: log.text() };
  } catch (error) {
    const reason = reasonOf(error);
    if (!reason) {
      logger.error({ project_id: projectId, version_id: id, err: error }, "sandbox build broke");
    }
    return {
      status: "failed",
      reason: reason ?? SERVICE_REASON,
      smoke: seen.smoke,
      log: log.text(),
    };
  }
}

/**
 * Loads the pushed image tarball into a prepare VM, tags it, runs the smoke check and, when the
 * check passes, saves the VM as a snapshot: the snapshot is the image reference. The VM is
 * deleted at the end, also after a failure.
 */
async function prepare(
  version: SandboxVersion,
  provider: SandboxProvider,
  bundles: BundleStore,
  deadlineMs: number,
  secrets: Record<string, string>,
  log: (text: string) => void,
  onSmoke: (result: SmokeResult) => void,
): Promise<string> {
  const { vmRef } = await provider.startVm({
    projectId: version.projectId,
    purpose: "prepare",
    ttlS: Math.ceil(deadlineMs / 1000) + PREPARE_GRACE_S,
    labels: {
      "ratel-project": version.projectId,
      "ratel-version": version.id,
      "ratel-purpose": "prepare",
    },
    // Inbound is open: a large file goes through an upload URL, and that URL does not work on a
    // VM with inbound closed. Outbound is open: the upload URL goes through a tunnel that the
    // `allow` and `deny` modes block.
    network: { inbound: "open", outbound: { mode: "open" } },
    keepSnapshots: true,
  });
  try {
    log("> writing the image\n");
    const body = await bundles.open(bundleKey(version));
    if (!body) throw new BuildFailed("The image tarball is not there. Push again.");
    const hash = createHash("sha256");
    await provider.writeFile(vmRef, {
      path: IMAGE_PATH,
      body: hashing(body, hash),
      size: version.bundle.bytes,
    });
    if (hash.digest("hex") !== version.bundle.sha256) {
      throw new BuildFailed("checking the image failed: it is not the pushed tarball. Push again.");
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
    const id = await step(
      provider,
      vmRef,
      "reading the image id",
      `docker image inspect --format '{{.Id}}' ${shellQuote(image)}`,
      log,
    );
    logImageId(id.trim(), version, log);
    const tag = imageTag(version.id);
    await step(
      provider,
      vmRef,
      "tagging the image",
      `docker tag ${shellQuote(image)} ${tag} && rm -f ${IMAGE_PATH}`,
      log,
    );
    const smoke = await runSmokeCheck(provider, vmRef, {
      versionId: version.id,
      config: version.config,
      tag,
      secrets,
      log,
    });
    onSmoke(smoke);
    if (!smoke.ok) throw new BuildFailed(smoke.error.message);
    // A snapshot must hold no secret value: no container, volume or file of the smoke check.
    const left = await smokeLeftovers(provider, vmRef);
    if (left) {
      log(`> the VM still holds:\n${left}\n`);
      throw new BuildFailed(LEFTOVERS_REASON);
    }
    log("> saving the image\n");
    const { snapshotRef } = await provider.saveSnapshot(vmRef, `rv-${version.id}`);
    return snapshotRef;
  } finally {
    await provider.deleteVm(vmRef).catch((error: unknown) => {
      // The TTL of the VM still ends it.
      logger.warn({ version_id: version.id, err: error }, "prepare vm not deleted");
    });
  }
}

/**
 * Docker reports the id of the loaded image. With the containerd image store the id of a pushed
 * image can be the digest of its index, not of its config, so another id does not fail the build:
 * the log keeps both.
 */
function logImageId(id: string, version: SandboxVersion, log: (text: string) => void) {
  const pushed = version.image?.digest;
  if (!pushed || id === pushed) return;
  log(`> the loaded image id is ${id}; the push named ${pushed}\n`);
}

/** The reason of a failure for the developer, or null when it is not known. */
function reasonOf(error: unknown): string | null {
  if (error instanceof BuildFailed) return error.message;
  if (error instanceof ProviderRateLimited) {
    const wait = error.retryAfterS === null ? "a minute" : `${Math.ceil(error.retryAfterS)} s`;
    return `The sandbox service has too many requests now. Push again in ${wait}.`;
  }
  if (error instanceof ProviderAtCapacity) {
    return "Ratel sandbox runs as many machines as it can now. Push again in a few minutes.";
  }
  if (error instanceof ProviderUnavailable) {
    return "The sandbox service did not answer. Push again later.";
  }
  return null;
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
