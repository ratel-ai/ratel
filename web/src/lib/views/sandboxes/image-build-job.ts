import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import type { BundleStore } from "@/lib/contracts/bundle-store";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageLimitsPort } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import { shellQuote } from "./container-run";
import { secretNamesOf } from "./domain/config";
import type { SmokeResult } from "./domain/contract";
import { snapshotName } from "./domain/snapshot-name";
import { bundleKey, type SandboxVersion } from "./domain/version";
import type { BuildOutcome, BuildStore } from "./ports/build-store";
import {
  accountRefusedReason,
  BuildFailed,
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderUnavailable,
  type SandboxProvider,
  type StartVmRequest,
} from "./ports/sandbox-provider";
import type { VmStore } from "./ports/vm-store";
import { openSecretValues, type SecretValuesDeps } from "./secret-values";
import { runSmokeCheck } from "./smoke-check";
import { agentVmNetwork, startVmSession, type VmSession } from "./vm-session";
import { recordVmStart, vmStartCheck } from "./vm-starts";

/**
 * The `sandbox_image_build` job: one pushed image becomes a ready version. A prepare VM, which
 * gets no secret, loads the image and is saved as the snapshot of the version. A smoke VM starts
 * from that snapshot with the policy of a run VM, gets the secrets and runs the smoke check. The
 * version is ready only after the check passes; else the snapshot is deleted.
 */
export type ImageBuildDeps = SecretValuesDeps & {
  builds: BuildStore;
  bundles: BundleStore;
  provider: SandboxProvider | null;
  /** The id of this deployment: the name of each snapshot carries it (`domain/snapshot-name.ts`). */
  deploymentId: string;
  /** The count of the prepare and smoke VM starts, with the starts of the run VMs. */
  vms: Pick<VmStore, "claimStart" | "markDeleted">;
  limits: UsageLimitsPort;
  organizationIdOf: (projectId: string) => Promise<string | null>;
  /** The address at which a container reaches this deployment. */
  callbackUrl: () => string;
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
const TOO_LONG_REASON = "The build took too long. Push again.";
const SERVICE_REASON = "The build service did not work. Push again.";
/** The end of the log is the part that explains a failure. */
const MAX_LOG_CHARS = 64_000;
/** The end of a failed step's output that goes in the reason. */
const MAX_REASON_OUTPUT_CHARS = 2_000;
const IMAGE_PATH = "/home/user/image.tar";
const STEP_TIMEOUT_S = 600;
/** A VM of a build lives a little longer than the deadline of its build, if the job does not delete it. */
const VM_GRACE_S = 300;

const payloadSchema = z.object({ versionId: z.uuid() });
const logger = getLogger("sandboxes/image-build");

/** One build: its version, its services and its log. */
type Build = {
  version: SandboxVersion;
  provider: SandboxProvider;
  deps: ImageBuildDeps;
  deadlineMs: number;
  log: (text: string) => void;
  onSmoke: (result: SmokeResult) => void;
  /** True after the build failed at its deadline: a step that ends later stops. */
  abandoned: () => boolean;
};

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

  const { provider } = deps;
  const stop = deps.every(HEARTBEAT_MS, () => {
    deps.builds.heartbeat(versionId, deps.now()).catch((error: unknown) => {
      logger.warn({ version_id: versionId, err: error }, "build heartbeat failed");
    });
  });
  try {
    const outcome = await build(version, provider, deps);
    // A version that is not ready keeps no snapshot.
    const dropUnkept = async () => {
      if (outcome.status === "ready") await dropSnapshot(provider, outcome.imageRef, versionId);
    };
    const finished = await deps.builds
      .finish(versionId, outcome, deps.now())
      .catch(async (error: unknown) => {
        await dropUnkept();
        throw error;
      });
    if (!finished) {
      // Another process ended the version first, e.g. the reaper after a lost heartbeat.
      await dropUnkept();
      logger.warn(
        { project_id: projectId, version_id: versionId, outcome: outcome.status },
        "sandbox build ended after its version was no longer preparing",
      );
      return { status: "stopped" };
    }
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
  const seen: { smoke: SmokeResult | null; abandoned: boolean } = { smoke: null, abandoned: false };
  try {
    const secrets = await openSecretValues(projectId, secretNamesOf(version.config), deps);
    if (!secrets.ok) throw new BuildFailed(secrets.message);
    const current: Build = {
      version,
      provider,
      deps,
      deadlineMs,
      log: log.add,
      onSmoke: (result) => {
        seen.smoke = result;
      },
      abandoned: () => seen.abandoned,
    };
    const work = withFeatureSpan(
      "sandboxes",
      "build_image",
      () => prepareAndCheck(current, secrets.values),
      { attributes: { "project.id": projectId, "sandbox.version_id": id } },
    );
    const imageRef = await within(deadlineMs, work).catch((error: unknown) => {
      seen.abandoned = true;
      throw error;
    });
    if (!seen.smoke?.ok) throw new Error("a ready version has no passed smoke check");
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
 * Saves the snapshot of the version from a prepare VM that gets no secret, then runs the smoke
 * check in a smoke VM that starts from the snapshot. The snapshot is the image reference. A failure
 * after the save deletes the snapshot.
 */
async function prepareAndCheck(current: Build, secrets: Record<string, string>): Promise<string> {
  const snapshotRef = await prepare(current);
  try {
    if (current.abandoned()) throw new BuildFailed(TOO_LONG_REASON);
    const smoke = await smokeCheck(current, snapshotRef, secrets);
    current.onSmoke(smoke);
    if (!smoke.ok) throw new BuildFailed(smoke.error.message);
    if (current.abandoned()) throw new BuildFailed(TOO_LONG_REASON);
    return snapshotRef;
  } catch (error) {
    await dropSnapshot(current.provider, snapshotRef, current.version.id);
    throw error;
  }
}

/**
 * Loads the pushed image tarball into a new prepare VM, tags it, removes the tarball and saves the
 * VM as a snapshot. The VM gets no secret. Its start counts as a VM start of the project. It is
 * deleted at the end, also after a failure.
 */
async function prepare(current: Build): Promise<string> {
  const { version, deps, log } = current;
  const vm = await startCountedVm(current, {
    purpose: "prepare",
    // Inbound is open: a large file goes through an upload URL, and that URL does not work on a
    // VM with inbound closed. Outbound is open: the upload URL goes through a tunnel that the
    // `allow` and `deny` modes block.
    network: { inbound: "open", outbound: { mode: "open" } },
    keepSnapshots: true,
  });
  try {
    log("> writing the image\n");
    const body = await deps.bundles.open(bundleKey(version));
    if (!body) throw new BuildFailed("The image tarball is not there. Push again.");
    const hash = createHash("sha256");
    await vm.writeFile({
      path: IMAGE_PATH,
      body: hashing(body, hash),
      size: version.bundle.bytes,
    });
    if (hash.digest("hex") !== version.bundle.sha256) {
      throw new BuildFailed("checking the image failed: it is not the pushed tarball. Push again.");
    }
    const loaded = await step(vm, "loading the image", `docker load -i ${IMAGE_PATH}`, log);
    const image = /^Loaded image(?: ID)?: (\S+)$/m.exec(loaded)?.[1];
    if (!image) throw new BuildFailed("loading the image failed: the tarball holds no image.");
    const id = await step(
      vm,
      "reading the image id",
      `docker image inspect --format '{{.Id}}' ${shellQuote(image)}`,
      log,
    );
    logImageId(id.trim(), version, log);
    const tag = imageTag(version.id);
    await step(
      vm,
      "tagging the image",
      `docker tag ${shellQuote(image)} ${tag} && rm -f ${IMAGE_PATH}`,
      log,
    );
    log("> saving the image\n");
    const { snapshotRef } = await vm.saveSnapshot(snapshotName(deps.deploymentId, version.id));
    return snapshotRef;
  } finally {
    await vm.end();
  }
}

/**
 * Runs the smoke check in a new smoke VM from the snapshot, with the policy of a run VM: inbound
 * closed, outbound to the allow-list only, and the secrets in the env file of the container only.
 * Its start counts as a VM start of the project. The VM is deleted at the end, also after a
 * failure: it got the secrets, so it never becomes a snapshot.
 */
async function smokeCheck(
  current: Build,
  snapshotRef: string,
  secrets: Record<string, string>,
): Promise<SmokeResult> {
  const { version, deps, log } = current;
  log("> starting the smoke VM from the snapshot\n");
  const vm = await startCountedVm(current, {
    purpose: "smoke",
    fromSnapshot: snapshotRef,
    network: agentVmNetwork(version.config, deps.callbackUrl()),
    keepSnapshots: false,
  });
  try {
    return await runSmokeCheck(vm, {
      versionId: version.id,
      config: version.config,
      tag: imageTag(version.id),
      secrets,
      log,
    });
  } finally {
    await vm.end();
  }
}

/**
 * Starts a VM of the build as a counted VM start of the project (`vm-starts.ts`). The start takes
 * a unit of the daily budget before the provider gets a call: a refusal fails the build with the
 * name of the limit. The usage records the start only when the VM started. `end` deletes the VM
 * and marks its row deleted; the row still counts in the budget of today. The row stays `starting`
 * with no reference until then, so no run claims the VM.
 */
async function startCountedVm(
  { version, provider, deps, deadlineMs }: Build,
  request: Pick<StartVmRequest, "purpose" | "fromSnapshot" | "network" | "keepSnapshots">,
): Promise<VmSession & { end: () => Promise<void> }> {
  const { projectId } = version;
  const { purpose } = request;
  const organizationId = await deps.organizationIdOf(projectId);
  if (!organizationId) throw new Error("the project has no organization");
  const subject = { organizationId, projectId };
  const claimed = await deps.vms.claimStart(
    { projectId, versionId: version.id, now: deps.now() },
    vmStartCheck(deps.limits, subject),
  );
  if (!claimed.ok) throw new BuildFailed(claimed.message);
  const row = claimed.vm;
  const markDeleted = () =>
    deps.vms.markDeleted(row.id, deps.now()).catch((error: unknown) => {
      logger.warn({ version_id: version.id, vm_id: row.id, purpose, err: error }, "vm not marked");
    });
  let vm: VmSession;
  try {
    vm = await startVmSession(provider, {
      ...request,
      projectId,
      ttlS: Math.ceil(deadlineMs / 1000) + VM_GRACE_S,
      labels: {
        "ratel-project": projectId,
        "ratel-version": version.id,
        "ratel-purpose": purpose,
        "ratel-vm": row.id,
      },
    });
  } catch (error) {
    await markDeleted();
    throw error;
  }
  await recordVmStart(deps.limits, subject, row.id, purpose);
  const end = async () => {
    await vm.delete().catch((error: unknown) => {
      // The TTL of the VM still ends it.
      logger.warn({ version_id: version.id, purpose, err: error }, "vm not deleted");
    });
    await markDeleted();
  };
  return Object.assign(vm, { end });
}

/** Deletes the snapshot of a version that is not ready. A failure is logged. */
async function dropSnapshot(provider: SandboxProvider, snapshotRef: string, versionId: string) {
  await provider.deleteSnapshot(snapshotRef).catch((error: unknown) => {
    logger.error({ version_id: versionId, err: error }, "snapshot not deleted");
  });
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
  return accountRefusedReason(error);
}

/** Runs one step of a build and logs its output. A failed step fails the build with its output. */
async function step(
  vm: VmSession,
  label: string,
  command: string,
  log: (text: string) => void,
): Promise<string> {
  log(`> ${label}\n`);
  const result = await vm.exec({ command, timeoutS: STEP_TIMEOUT_S });
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
