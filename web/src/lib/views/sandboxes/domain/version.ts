import type { RatelYaml } from "./config";
import type { SmokeResult } from "./smoke";

export const VERSION_STATUSES = ["uploading", "uploaded", "preparing", "ready", "failed"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** One pushed version. Only its preparation state changes after the push. */
export type SandboxVersion = {
  id: string;
  projectId: string;
  sandboxId: string;
  name: string;
  /** The parsed `ratel.yaml`. */
  config: RatelYaml;
  /** The pushed image. Null for a version pushed before images. */
  image: { digest: string; platform: string | null } | null;
  /** Null when the push had no git information. */
  git: { commit: string; dirty: boolean } | null;
  /** The tarball of the image (gzip of `docker save`). */
  bundle: { sha256: string; bytes: number };
  status: VersionStatus;
  /** Why the preparation failed or did not start. */
  reason: string | null;
  /** The name of the snapshot that holds the loaded image. Set when the version is ready. */
  imageRef: string | null;
  smoke: SmokeResult | null;
  buildLog: string | null;
  createdAt: Date;
};

/** Where a version's tarball is in the bundle store. */
export function bundleKey(version: Pick<SandboxVersion, "projectId" | "id">): string {
  return `${version.projectId}/${version.id}.tar.gz`;
}

/**
 * The wire shape (`version.schema.json`). It has no snapshot name and no preparation log. `url` is
 * the page of the version on Ratel.
 */
export function versionView(version: SandboxVersion, url?: string) {
  return {
    versionId: version.id,
    name: version.name,
    status: version.status,
    reason: version.reason,
    ...(version.image
      ? {
          image: {
            digest: version.image.digest,
            ...(version.image.platform ? { platform: version.image.platform } : {}),
          },
        }
      : {}),
    git: version.git,
    bundle: version.bundle,
    config: version.config,
    ...(version.smoke ? { smoke: version.smoke } : {}),
    createdAt: version.createdAt.toISOString(),
    ...(url ? { url } : {}),
  };
}
