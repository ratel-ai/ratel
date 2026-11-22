import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import type { SessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { type GitHubAppConfig, readGitHubAppConfig } from "./config";
import { codeHandoffEnabledFor } from "./gate";
import { createInstallationTokens, type InstallationTokens } from "./github/app-auth";
import { createGitHubClient } from "./github/client";
import type { LinkServiceDeps } from "./link-service";
import type { GitHubPort } from "./ports";
import { getRepoLink, linkRepo, unlinkRepo } from "./store";

/**
 * The real dependencies of the link service for one signed-in person: the
 * GitHub client from the App's settings, the person's project access, the
 * switch in the project's organization, the store and analytics.
 *
 * Owned (ADR-0030): the project scope is the console's (the session's membership, so one
 * argument), and the switch is `FF_CODE_HANDOFF` for the person in the project's organization.
 * The GitHub App's settings come from the environment (`config.ts`): a self-hoster registers
 * their own App.
 */

const logger = getLogger("code-handoff/link");
let tokenCache: { appId: string; tokens: InstallationTokens } | null = null;

export function linkServiceDepsFor(session: SessionContext): LinkServiceDeps {
  const config = readGitHubAppConfig();
  return {
    secret: config?.webhookSecret ?? null,
    github: config ? gitHubFor(config) : notConfiguredGitHub,
    projectAccess: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { organizationId: scope.organization.id } : null;
    },
    flagEnabled: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? codeHandoffEnabledFor(scope.organization, {}, session.user.externalId) : false;
    },
    isRestricted: isRestrictedBySupportSession,
    getRepoLink: (projectId) => getRepoLink(projectId),
    linkRepo: (link) => linkRepo(link),
    unlinkRepo: (projectId) => unlinkRepo(projectId),
    track: (event, context, properties) => trackServerEvent(event, context, properties),
    log: (fields, message) => logger.info(fields, message),
    now: () => Date.now(),
  };
}

/** The GitHub client for the App, its installation tokens shared across requests. */
export function gitHubFor(config: GitHubAppConfig): GitHubPort {
  if (!tokenCache || tokenCache.appId !== config.appId) {
    tokenCache = {
      appId: config.appId,
      tokens: createInstallationTokens(config, { fetch, now: () => Date.now() }),
    };
  }
  return createGitHubClient({
    tokens: tokenCache.tokens,
    oauthClient: { clientId: config.clientId, clientSecret: config.clientSecret },
    fetch,
  });
}

const notConfigured = async (): Promise<never> => {
  throw new Error("github app is not configured");
};

const notConfiguredGitHub: GitHubPort = {
  exchangeUserCode: notConfigured,
  listUserInstallations: notConfigured,
  listInstallationRepos: notConfigured,
  getRepo: notConfigured,
  createIssue: notConfigured,
  searchCode: notConfigured,
  readFile: notConfigured,
};
