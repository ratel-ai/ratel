/**
 * The Slack app the console installs (ADR-0004). In the open-source edition each organization
 * saves its own app in its settings. An edition that owns one app for everyone supplies this port:
 * the settings then show no app fields.
 */
export type SlackAppCredentials = { clientId: string; clientSecret: string };

export type SlackAppPort = {
  /** Null while the edition has no app: Slack is then not available yet. Never log the answer. */
  credentials(organizationId: string): Promise<SlackAppCredentials | null>;
};
