/** What a page may know of an organization's Slack app. Never its secret. Safe for the browser. */
export type SlackAppStatus =
  /** The edition supplies the app, or has none yet. */
  | { kind: "edition"; available: boolean }
  /** The organization saves its own. */
  | { kind: "organization"; clientId: string | null };

/** What a page may know of the connected workspace. Never its token. */
export interface SlackConnection {
  teamId: string;
  teamName: string;
  /** Slack refused the token, or it cannot be opened. */
  lost: boolean;
}

export const CANNOT_STORE =
  "This deployment cannot store secrets. Set RATEL_SECRET_KEY and restart it.";

export const NOT_ADMIN = "Only an organization admin can connect Slack.";

/** An edition that supplies the app has none yet. */
export const SLACK_UNAVAILABLE = "Slack is not available yet.";

/** How an install ended, as the callback tells the Notifications page (`?slack=`). */
export const INSTALL_NOTICES = {
  connected: "Slack is connected.",
  denied: "The install was canceled in Slack.",
  not_configured:
    "No Slack app is configured for this organization, or its secret must be saved again.",
  already_connected: "A Slack workspace is already connected. Disconnect it first.",
  rotation: "Turn off token rotation in the Slack app's settings, then connect again.",
  no_workspace: "Install the app in one workspace, not in a whole Slack organization.",
  no_scopes: "Slack did not grant the permissions the app needs. Connect again and allow them.",
  failed: "Slack refused the install.",
} as const;

export type InstallNotice = keyof typeof INSTALL_NOTICES;
