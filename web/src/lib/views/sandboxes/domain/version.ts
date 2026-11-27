import type { SandboxManifest } from "./manifest";

export const VERSION_STATUSES = ["uploading", "uploaded", "building", "ready", "failed"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** One pushed version. Only its build state changes after the push. */
export type SandboxVersion = {
  id: string;
  projectId: string;
  sandboxId: string;
  name: string;
  manifest: SandboxManifest;
  git: { commit: string; dirty: boolean };
  bundle: { sha256: string; bytes: number };
  status: VersionStatus;
  /** Why the build failed or did not start. */
  reason: string | null;
  imageRef: string | null;
  buildLog: string | null;
  createdAt: Date;
};

/** Where a version's bundle is in the bundle store. */
export function bundleKey(version: Pick<SandboxVersion, "projectId" | "id">): string {
  return `${version.projectId}/${version.id}.tar.gz`;
}

/** The wire shape (`version.schema.json`). It has no image reference and no log. */
export function versionView(version: SandboxVersion) {
  return {
    versionId: version.id,
    name: version.name,
    status: version.status,
    reason: version.reason,
    git: version.git,
    bundle: version.bundle,
    manifest: version.manifest,
    createdAt: version.createdAt.toISOString(),
  };
}
