import { configured } from "@/lib/platform/env-configured";

/**
 * The Ratel GitHub App's settings, from the environment. All six are needed;
 * with any one missing (or still Terraform's `REPLACE_ME` seed) the feature
 * reports "not configured" and stays inert, so the app boots without them.
 * Never log the values.
 */

export interface GitHubAppConfig {
  appId: string;
  /** The App's URL name: the install link is `https://github.com/apps/<slug>/installations/new`. */
  slug: string;
  privateKey: string;
  webhookSecret: string;
  /** The App's OAuth client: install asks for user authorization, and its `code` is traded with these. */
  clientId: string;
  clientSecret: string;
}

export const GITHUB_APP_ENV_NAMES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;

/** The App's settings, or null when any is missing, blank or the placeholder. */
export function readGitHubAppConfig(
  env: Record<string, string | undefined> = process.env,
): GitHubAppConfig | null {
  const [appId, slug, privateKey, webhookSecret, clientId, clientSecret] = GITHUB_APP_ENV_NAMES.map(
    (name) => configured(env[name]) ?? "",
  );
  if (!appId || !slug || !privateKey || !webhookSecret || !clientId || !clientSecret) return null;
  return { appId, slug, privateKey, webhookSecret, clientId, clientSecret };
}

/** Where a person installs the App. GitHub passes `state` back; the setup route matches it to the install cookie. */
export function appInstallUrl(config: Pick<GitHubAppConfig, "slug">, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** GitHub's user authorization for an App already installed: the redirect carries `code` and `state`. */
export function appAuthorizeUrl(config: Pick<GitHubAppConfig, "clientId">, state: string): string {
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.clientId)}&state=${encodeURIComponent(state)}`;
}
