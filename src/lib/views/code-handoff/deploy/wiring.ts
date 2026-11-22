import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { loadFixes } from "@/lib/views/fixes/load";
import { recordFixShipment } from "@/lib/views/fixes/record-shipment";
import { findFix } from "@/lib/views/fixes/select";
import {
  claimCommit,
  findCommitsBySha,
  findShipment,
  listUndeployedTaggedCommits,
  releaseCommit,
  setCommitShipments,
} from "./commits";
import type { RecordDeployDeps } from "./deployed";

/**
 * The real dependencies of `recordDeploy` (RC-920): the commit queries, the
 * project's fixes as Fixes loads them, and the shared shipment recorder.
 */

export const defaultRecordDeployDeps: RecordDeployDeps = {
  findCommitsBySha: (repoLinkId, prefix, limit) => findCommitsBySha(repoLinkId, prefix, limit),
  listUndeployedTaggedCommits: (repoLinkId, maxSeq) =>
    listUndeployedTaggedCommits(repoLinkId, maxSeq),
  claimCommit: (commitId, deployedAt) => claimCommit(commitId, deployedAt),
  releaseCommit: (commitId) => releaseCommit(commitId),
  setCommitShipments: (commitId, shipmentIds) => setCommitShipments(commitId, shipmentIds),
  loadProjectFixes: async (projectId) => {
    const organization = await getOrganizationByProjectId(projectId);
    if (!organization) return null;
    const model = await loadFixes({ projectId, organization, topics: false });
    const fixes = [...model.open, ...model.applied];
    return (fixId) => findFix(fixes, fixId);
  },
  recordFixShipment: (input) => recordFixShipment(input),
  findShipment: (projectId, fixId, version) => findShipment(projectId, fixId, version),
  now: () => new Date(),
};
