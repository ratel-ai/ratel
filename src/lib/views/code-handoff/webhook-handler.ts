import { getLogger } from "@/lib/platform/logger";
import { readGitHubAppConfig } from "./config";
import { handleDeploymentStatus } from "./deploy/on-deployment-status";
import { handlePush } from "./deploy/on-push";
import { codeHandoffEnabledForActor } from "./gate";
import { verifyWebhookSignature } from "./github/webhook-signature";
import type { RepoLinkRow } from "./schema";
import { deleteRepoLinks, listRepoLinksByInstallation } from "./store";

/**
 * GitHub App webhooks (RC-914), split from `app/api/github/webhook/route.ts`
 * so they are testable without Next or a database.
 *
 * The signature is checked on the raw body before anything is parsed. Then
 * `X-GitHub-Event` picks a handler from `GITHUB_EVENT_HANDLERS`: the seam the
 * deploy milestone extends. An event without a handler answers 200 and writes
 * nothing. `FF_CODE_HANDOFF` is decided per link's project: a link whose
 * project has it off is left as it is.
 *
 * Owned (ADR-0030): a comment named a Cloud vendor's webhook; the switch is the core's.
 */

export interface GitHubWebhookDeps {
  /** The webhook secret, or null when the App is not configured. */
  webhookSecret: () => string | null;
  flagEnabledForProject: (projectId: string) => Promise<boolean>;
  listRepoLinksByInstallation: (installationId: number) => Promise<RepoLinkRow[]>;
  deleteRepoLinks: (linkIds: string[]) => Promise<number>;
}

export interface GitHubEventResult {
  /** Links removed. */
  removed: number;
  /** Pushed commits recorded (`push` only). */
  stored?: number;
  /** Fix shipments recorded (`deployment_status` only). */
  shipped?: number;
}

export type GitHubEventHandler = (
  payload: GitHubWebhookPayload,
  deps: GitHubWebhookDeps,
) => Promise<GitHubEventResult>;

export interface GitHubWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repositories_removed?: { id?: number }[];
}

/** The flag decision of a webhook: no person, so only organization targeting applies. */
export const WEBHOOK_ACTOR = "system:github-webhook";

const logger = getLogger("code-handoff/webhook");

/** One handler per `X-GitHub-Event`. */
export const GITHUB_EVENT_HANDLERS: Record<string, GitHubEventHandler> = {
  installation: handleInstallation,
  installation_repositories: handleInstallationRepositories,
  push: handlePush,
  deployment_status: handleDeploymentStatus,
};

const defaultDeps: GitHubWebhookDeps = {
  webhookSecret: () => readGitHubAppConfig()?.webhookSecret ?? null,
  flagEnabledForProject: (projectId) => codeHandoffEnabledForActor(projectId, WEBHOOK_ACTOR),
  listRepoLinksByInstallation: (installationId) => listRepoLinksByInstallation(installationId),
  deleteRepoLinks: (linkIds) => deleteRepoLinks(linkIds),
};

export function createGitHubWebhookHandler(
  deps: GitHubWebhookDeps = defaultDeps,
  handlers: Record<string, GitHubEventHandler> = GITHUB_EVENT_HANDLERS,
): (req: Request) => Promise<Response> {
  return async function handleGitHubWebhook(req: Request): Promise<Response> {
    const secret = deps.webhookSecret();
    if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });

    const rawBody = await req.text();
    if (!verifyWebhookSignature(rawBody, req.headers.get("x-hub-signature-256"), secret)) {
      logger.warn(
        { delivery: req.headers.get("x-github-delivery") },
        "rejected github webhook with a bad signature",
      );
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    const event = req.headers.get("x-github-event") ?? "";
    const handler = Object.hasOwn(handlers, event) ? handlers[event] : undefined;
    if (!handler) return Response.json({ ignored: true });

    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubWebhookPayload;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const result = await handler(payload, deps);
    logger.info({ event, action: payload.action, ...result }, "handled github webhook");
    return Response.json(result);
  };
}

/** The App was uninstalled: every link made through it goes. */
async function handleInstallation(
  payload: GitHubWebhookPayload,
  deps: GitHubWebhookDeps,
): Promise<GitHubEventResult> {
  const installationId = payload.installation?.id;
  if (payload.action !== "deleted" || !Number.isSafeInteger(installationId)) return { removed: 0 };
  const links = await deps.listRepoLinksByInstallation(installationId as number);
  return { removed: await removeFlagged(links, deps) };
}

/** Repos left the installation's access: their links go. */
async function handleInstallationRepositories(
  payload: GitHubWebhookPayload,
  deps: GitHubWebhookDeps,
): Promise<GitHubEventResult> {
  const installationId = payload.installation?.id;
  if (payload.action !== "removed" || !Number.isSafeInteger(installationId)) return { removed: 0 };
  const removedRepoIds = new Set((payload.repositories_removed ?? []).map((repo) => repo.id));
  if (removedRepoIds.size === 0) return { removed: 0 };
  const links = await deps.listRepoLinksByInstallation(installationId as number);
  return {
    removed: await removeFlagged(
      links.filter((link) => removedRepoIds.has(link.repoId)),
      deps,
    ),
  };
}

/** Delete the links whose project has the flag on. */
async function removeFlagged(links: RepoLinkRow[], deps: GitHubWebhookDeps): Promise<number> {
  const flagged: string[] = [];
  for (const link of links) {
    if (await deps.flagEnabledForProject(link.projectId)) flagged.push(link.id);
  }
  return deps.deleteRepoLinks(flagged);
}
