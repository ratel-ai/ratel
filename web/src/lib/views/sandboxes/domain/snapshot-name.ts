import { createHash } from "node:crypto";

/** 63 characters, less `rv-`, the `-` after the tag and 36 of the UUID. */
const MAX_TAG = 23;
const HASH_TAG = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The name of the snapshot of a version: `rv-<deployment tag>-<version id>`. The tag lets the
 * orphan sweep find the snapshots of this deployment only: several deployments can share one
 * account of the VM service. The tag is the deployment id when it is short, else a hash of it, so
 * the name stays in the pattern of the service (`^[a-z0-9][a-z0-9-]{0,62}$`).
 *
 * A snapshot saved before the tag is `rv-<version id>`. It is not a name of any deployment, so no
 * sweep deletes it.
 */
export function snapshotName(deploymentId: string, versionId: string): string {
  return `${prefixOf(deploymentId)}${versionId}`;
}

/**
 * The version of a snapshot of this deployment, or null for any other name. The rest of the name
 * after the prefix must be exactly a UUID, so the prefix of a deployment never matches a name of
 * another deployment whose id starts the same way.
 */
export function snapshotVersionId(deploymentId: string, name: string): string | null {
  const prefix = prefixOf(deploymentId);
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  return UUID.test(rest) ? rest : null;
}

function prefixOf(deploymentId: string): string {
  const tag =
    deploymentId.length <= MAX_TAG
      ? deploymentId
      : createHash("sha256").update(deploymentId).digest("hex").slice(0, HASH_TAG);
  return `rv-${tag}-`;
}
