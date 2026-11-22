import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { listRepoLinksByRepo } from "../store";
import type {
  GitHubEventHandler,
  GitHubEventResult,
  GitHubWebhookDeps,
  GitHubWebhookPayload,
} from "../webhook-handler";
import { type DeployResult, recordDeploy } from "./deployed";
import { defaultRecordDeployDeps } from "./wiring";

/**
 * The `deployment_status` webhook (RC-920): a successful deployment of a sha
 * of a linked repo ships the fixes its commits name. Any environment counts
 * in this version. `FF_CODE_HANDOFF` is decided per link's project.
 */

export interface DeploymentStatusDeps {
  listRepoLinksByRepo: (repoId: number) => Promise<RepoLinkRow[]>;
  recordDeploy: (link: RepoLinkRow, sha: string) => Promise<DeployResult>;
}

export interface DeploymentStatusPayload extends GitHubWebhookPayload {
  deployment_status?: { state?: string };
  deployment?: { sha?: string; environment?: string };
  repository?: { id?: number };
}

const defaultDeps: DeploymentStatusDeps = {
  listRepoLinksByRepo: (repoId) => listRepoLinksByRepo(repoId),
  recordDeploy: (link, sha) =>
    recordDeploy(link, sha, "deployment_status", defaultRecordDeployDeps),
};

export const handleDeploymentStatus: GitHubEventHandler =
  createDeploymentStatusHandler(defaultDeps);

export function createDeploymentStatusHandler(own: DeploymentStatusDeps): GitHubEventHandler {
  return async function onDeploymentStatus(
    raw: GitHubWebhookPayload,
    deps: GitHubWebhookDeps,
  ): Promise<GitHubEventResult> {
    const payload = raw as DeploymentStatusPayload;
    const repoId = payload.repository?.id;
    const installationId = payload.installation?.id;
    const sha = payload.deployment?.sha;
    if (payload.deployment_status?.state !== "success" || typeof sha !== "string")
      return { removed: 0, shipped: 0 };
    if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(installationId))
      return { removed: 0, shipped: 0 };
    const links = (await own.listRepoLinksByRepo(repoId as number)).filter(
      (link) => link.installationId === installationId,
    );
    let shipped = 0;
    for (const link of links) {
      if (!(await deps.flagEnabledForProject(link.projectId))) continue;
      shipped += (await own.recordDeploy(link, sha)).shipped;
    }
    return { removed: 0, shipped };
  };
}
