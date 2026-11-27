import { getConfig } from "@/config";
import { slackCaller } from "@/lib/views/slack/api";
import type { SlackWorkspaceDeps } from "@/lib/views/slack/channels";
import { markSlackLost, sealedSlackConnection } from "@/lib/views/slack/store";

/** The stored connection and the real Slack. */
export function slackWorkspace(): SlackWorkspaceDeps {
  return {
    connection: (organizationId) => sealedSlackConnection(organizationId),
    markLost: (connection) => markSlackLost(connection),
    call: slackCaller(getConfig().slack.url),
  };
}
