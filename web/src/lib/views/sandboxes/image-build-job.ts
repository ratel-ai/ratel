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
  now: () => Date;
  /** Calls `beat` again and again until the returned function is called. */
  every: (ms: number, beat: () => void) => () => void;
};

export const HEARTBEAT_MS = 30_000;
/** With no heartbeat for this time the process of a build is gone. */
export const BUILD_STOPPED_MS = 5 * 60_000;
export const NOT_CONFIGURED_REASON = "Ratel sandbox is not configured on this deployment.";
export const STOPPED_REASON = "The build was interrupted. Push again.";
const SERVICE_REASON = "The build service did not work. Push again.";
/** The end of the log is the part that explains a failure. */
const MAX_LOG_CHARS = 64_000;

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
    const outcome = await build(version, deps.provider, deps.bundles);
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
  bundles: BundleStore,
): Promise<BuildOutcome> {
  const { id, projectId, manifest, bundle } = version;
  const log = createLog();
  try {
    const { imageRef } = await withFeatureSpan(
      "sandboxes",
      "build_image",
      () =>
        provider.buildImage({
          versionId: id,
          projectId,
          base: manifest.base,
          install: manifest.install,
          entry: manifest.entry,
          bundle: { ...bundle, body: bodyOf(version, bundles) },
          log: log.add,
        }),
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

/** Opens the bundle when the provider reads it, so no connection waits for the base image. */
async function* bodyOf(version: SandboxVersion, bundles: BundleStore) {
  const body = await bundles.open(bundleKey(version));
  if (!body) throw new BuildFailed("The bundle is not there. Push again.");
  yield* body;
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
