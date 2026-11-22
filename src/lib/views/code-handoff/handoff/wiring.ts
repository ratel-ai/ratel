import type { Organization } from "@/lib/platform/organizations";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { readGitHubAppConfig } from "../config";
import { getFixHandoff, getRepoLink, recordFixHandoff } from "../store";
import { gitHubFor, notConfiguredGitHub } from "../wiring";
import { INDEX_STALE_MS } from "./code-index";
import { createGitHubIssueClaudeTarget } from "./github-issue-claude";
import type { HandoffFixDeps } from "./handoff-fix";
import { loadHandoffBrief } from "./load-brief";
import { requestCodeIndex } from "./request-index";

/**
 * The real dependencies of a handoff (RC-918) in one organization.
 */
export function handoffFixDeps(input: { organization: Organization }): HandoffFixDeps {
  const config = readGitHubAppConfig();
  const github = config ? gitHubFor(config) : notConfiguredGitHub;
  return {
    getRepoLink: (projectId) => getRepoLink(projectId),
    getRepo: (installationId, repo) => github.getRepo(installationId, repo),
    getHandoff: (projectId, fixId, target) => getFixHandoff(projectId, fixId, target),
    loadBrief: (projectId, fixId) =>
      loadHandoffBrief({ projectId, organization: input.organization, fixId }),
    target: createGitHubIssueClaudeTarget(github),
    recordHandoff: (handoff) => recordFixHandoff(handoff),
    track: (event, context, properties) => trackServerEvent(event, context, properties),
    requestIndex: (projectId) => requestCodeIndex(projectId, { staleAfterMs: INDEX_STALE_MS }),
  };
}
