import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import type { LinkError, SetupResult } from "./link-service";

/** Where code handoff's pages live, and where the setup redirect sends a person. Pure. */

export function repositorySettingsPath(projectId: string): string {
  return `${projectSettingsRoot(projectId)}/repository`;
}

/** The cookie that carries the signed setup state across GitHub (httpOnly, `/api/github` only). */
export const SETUP_STATE_COOKIE = "ratel_github_setup";

/**
 * Our Install link: the route sets the state cookie, then sends the person to
 * GitHub. `authorize` is for an App already installed: GitHub's user
 * authorization alone, which brings back the same `code`.
 */
export function installStartPath(
  projectId: string,
  mode: "install" | "authorize" = "install",
): string {
  const query = new URLSearchParams({
    project: projectId,
    ...(mode === "authorize" ? { mode } : {}),
  });
  return `/api/github/install?${query.toString()}`;
}

/**
 * After GitHub's setup redirect: the Repository tab with the grant, or with
 * `?error=<code>`. A state that never checked out names no project, so the
 * person goes home with the error.
 */
export function setupRedirectPath(result: SetupResult): string {
  if (result.ok)
    return `${repositorySettingsPath(result.projectId)}?grant=${encodeURIComponent(result.grant)}`;
  const target = result.projectId ? repositorySettingsPath(result.projectId) : "/";
  return `${target}?github_setup_error=${result.error}`;
}

/** What the Repository tab says for each refusal. */
export const LINK_ERROR_MESSAGES: Record<LinkError, string> = {
  not_configured: "The GitHub App is not configured for this deployment.",
  forbidden: "You do not have access to this project.",
  flag_off: "Repository links are not enabled for this organization.",
  support_session: SUPPORT_SESSION_RESTRICTED_MESSAGE,
  invalid_state: "The install link expired or was not made for you. Start again from Install.",
  wrong_user: "The install link was made for another person. Start again from Install.",
  unknown_installation: "GitHub did not return a Ratel App installation. Start again from Install.",
  unverified_installation:
    "GitHub did not confirm that you can reach that installation. Start again from Install and authorize the App.",
  invalid_grant: "The repository list expired. Start again from Install.",
  repo_not_found:
    "The Ratel App cannot reach that repository. Give it access on GitHub, then try again.",
};
