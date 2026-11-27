import { getDb } from "@/lib/platform/db/client";
import { revokeToken, type SlackWorkspaceDeps } from "@/lib/views/slack/channels";
import { deleteSlackApp, deleteSlackConnection, type SlackDb } from "@/lib/views/slack/store";
import { slackWorkspace } from "@/lib/views/slack/workspace";

/**
 * Removes an organization's Slack connection and Slack app, with their secrets. Slack is asked to
 * end the token first, at best: an answer that is a failure keeps no row. No foreign key does this,
 * because the organizations are the edition's.
 */
export async function forgetOrganization(
  organizationId: string,
  db: SlackDb = getDb(),
  workspace: SlackWorkspaceDeps = slackWorkspace(),
): Promise<void> {
  await revokeToken(organizationId, workspace);
  await deleteSlackConnection(organizationId, db);
  await deleteSlackApp(organizationId, db);
}
