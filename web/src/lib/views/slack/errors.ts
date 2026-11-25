/** The app is not in the channel. Slack hides a private channel the app is not in. */
const NOT_IN_CHANNEL: ReadonlySet<string> = new Set(["not_in_channel", "channel_not_found"]);
/** The token is not good any more. */
const DISCONNECTED: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const TEXTS: Readonly<Record<string, string>> = {
  is_archived: "The channel is archived.",
  timeout: "Slack did not answer in time.",
  unreachable: "Slack could not be reached.",
  bad_answer: "Slack's answer could not be read.",
  ratelimited: "Slack gets too many requests. Try again in a minute.",
  missing_scope: "The Slack app lacks a permission: disconnect it and connect again.",
  not_connected: "Slack is not connected.",
  other_workspace: "This channel is in another Slack workspace: remove it and add it again.",
};

/** A code as a person reads it. Safe for the browser. */
export function slackErrorText(code: string): string {
  if (NOT_IN_CHANNEL.has(code)) return "This app is not in the channel: invite it with /invite.";
  if (DISCONNECTED.has(code)) return "Slack is disconnected: connect again.";
  return TEXTS[code] ?? `Slack answered ${code}.`;
}

/** Whether a code says that the connection is lost. */
export function isLostConnection(code: string): boolean {
  return DISCONNECTED.has(code);
}

/** Whether a code is about the one channel: it is kept with the destination until a post arrives. */
export function isChannelError(code: string): boolean {
  return NOT_IN_CHANNEL.has(code) || code === "is_archived";
}
