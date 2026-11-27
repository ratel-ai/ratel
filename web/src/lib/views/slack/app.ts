import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { SlackAppCredentials, SlackAppPort } from "@/lib/contracts/slack-app";
import { readSlackApp, savedClientId } from "@/lib/views/slack/store";
import type { SlackAppStatus } from "@/lib/views/slack/types";

/** Post, post in public channels it was not invited to, and list public and private channels. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
] as const;

const CALLBACK_PATH = "/api/integrations/slack/callback";
const CREATE_APP_URL = "https://api.slack.com/apps";
/** Slack's limit of an app's name. */
const MAX_APP_NAME = 35;

/** The app to install for an organization: the edition's where it supplies one, else the saved one. */
export async function slackAppOf(
  organizationId: string,
  port: SlackAppPort | undefined = composition.slackApp,
): Promise<SlackAppCredentials | null> {
  return port ? port.credentials(organizationId) : readSlackApp(organizationId);
}

export async function slackAppStatus(
  organizationId: string,
  port: SlackAppPort | undefined = composition.slackApp,
): Promise<SlackAppStatus> {
  if (port)
    return { kind: "edition", available: (await port.credentials(organizationId)) !== null };
  return { kind: "organization", clientId: await savedClientId(organizationId) };
}

/** This deployment's origin: `APP_PUBLIC_URL`, else `BASE_URL`, which is what a self-hoster sets. */
export function deploymentOrigin(): string {
  const { publicUrl, baseUrl } = getConfig().app;
  return (publicUrl || baseUrl).replace(/\/+$/, "");
}

export function slackRedirectUrl(origin: string = deploymentOrigin()): string {
  return `${origin}${CALLBACK_PATH}`;
}

/** Slack's create-app page, with everything filled in. */
export function slackManifestUrl(appName: string, redirectUrl: string): string {
  const name = appName.slice(0, MAX_APP_NAME);
  const manifest = {
    display_information: { name },
    features: { bot_user: { display_name: name, always_online: false } },
    oauth_config: { redirect_urls: [redirectUrl], scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  const query = new URLSearchParams({ new_app: "1", manifest_json: JSON.stringify(manifest) });
  // Slack reads the manifest with `+` kept as a plus.
  return `${CREATE_APP_URL}?${query.toString().replaceAll("+", "%20")}`;
}

/** Slack's consent page. */
export function slackAuthorizeUrl(
  clientId: string,
  state: string,
  { slackUrl, redirectUrl }: { slackUrl: string; redirectUrl: string },
): string {
  const query = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: redirectUrl,
    state,
  });
  return `${slackUrl.replace(/\/+$/, "")}/oauth/v2/authorize?${query}`;
}
