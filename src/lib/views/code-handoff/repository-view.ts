import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import {
  type GrantRepo,
  type LinkActor,
  type LinkError,
  type LinkServiceDeps,
  listGrantRepos,
} from "./link-service";
import { installStartPath, LINK_ERROR_MESSAGES } from "./paths";

/**
 * What Project settings › Repository shows (RC-914), decided away from React:
 * not configured, linked, picking a repo after the setup redirect, or not
 * connected with an Install link.
 */

export type RepositoryView =
  | { state: "not_configured" }
  | {
      state: "linked";
      link: Pick<RepoLinkRow, "owner" | "name" | "defaultBranch">;
      url: string;
      hint: SetupHint;
    }
  | {
      state: "picking";
      grant: string;
      repos: GrantRepo[];
      installUrl: string;
      authorizeUrl: string;
      error: string | null;
    }
  | { state: "not_connected"; installUrl: string; authorizeUrl: string; error: string | null };

export interface SetupHint {
  /** The bot login the Claude Code GitHub Action must allow: `<slug>[bot]`. */
  botLogin: string;
}

export interface RepositoryViewInput {
  actor: LinkActor;
  /** The App's URL name, or null when the App is not configured. */
  appSlug: string | null;
  grant: string | null;
  setupError: string | null;
}

export async function loadRepositoryView(
  input: RepositoryViewInput,
  deps: LinkServiceDeps,
): Promise<RepositoryView> {
  if (!input.appSlug || !deps.secret) return { state: "not_configured" };
  const link = await deps.getRepoLink(input.actor.projectId);
  if (link) {
    return {
      state: "linked",
      link: { owner: link.owner, name: link.name, defaultBranch: link.defaultBranch },
      url: `https://github.com/${link.owner}/${link.name}`,
      hint: { botLogin: `${input.appSlug}[bot]` },
    };
  }
  const installUrl = installStartPath(input.actor.projectId);
  const authorizeUrl = installStartPath(input.actor.projectId, "authorize");
  let error = errorMessage(input.setupError);
  if (input.grant) {
    const listed = await listGrantRepos(input.actor, input.grant, deps);
    if (listed.ok)
      return {
        state: "picking",
        grant: input.grant,
        repos: listed.repos,
        installUrl,
        authorizeUrl,
        error,
      };
    error = LINK_ERROR_MESSAGES[listed.error];
  }
  return { state: "not_connected", installUrl, authorizeUrl, error };
}

function errorMessage(code: string | null): string | null {
  if (!code) return null;
  return Object.hasOwn(LINK_ERROR_MESSAGES, code)
    ? LINK_ERROR_MESSAGES[code as LinkError]
    : "GitHub setup did not finish. Start again from Install.";
}
