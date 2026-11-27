import type { OrgRole } from "@/lib/contracts/session";
import { type AlertAccessDeps, authorizeAlerts } from "@/lib/views/alerts/actions";
import type { ChannelList, SlackChannel } from "@/lib/views/slack/channels";
import { slackErrorText } from "@/lib/views/slack/errors";

export type ChannelsResult =
  | { ok: true; channels: SlackChannel[]; partial: boolean }
  | { ok: false; error: string };

/** The channels to pick from, for a person who may change the project's alerts. */
export async function readChannels(
  projectId: unknown,
  deps: AlertAccessDeps & { list(organizationId: string): Promise<ChannelList> },
): Promise<ChannelsResult> {
  const access = await authorizeAlerts(projectId, deps);
  if (!access.ok) return access;
  const list = await deps.list(access.subject.organizationId);
  return list.ok ? list : { ok: false, error: slackErrorText(list.code) };
}

export interface DisconnectDeps extends AlertAccessDeps {
  role(projectId: string): Promise<OrgRole | null>;
  /** Asks Slack to end the token. A failure does not keep the connection. */
  revoke(organizationId: string): Promise<unknown>;
  remove(organizationId: string): Promise<boolean>;
  observe(fields: { project_id: string; organization_id: string; actor: string }): Promise<void>;
}

/** Forget the workspace, for every project of the organization: its admins only. */
export async function disconnectSlack(
  projectId: unknown,
  deps: DisconnectDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await authorizeAlerts(projectId, deps);
  if (!access.ok) return access;
  const { subject } = access;
  if ((await deps.role(subject.projectId)) !== "admin")
    return { ok: false, error: "Only an organization admin can disconnect Slack." };
  await deps.revoke(subject.organizationId);
  await deps.remove(subject.organizationId);
  await deps.observe({
    project_id: subject.projectId,
    organization_id: subject.organizationId,
    actor: subject.actor,
  });
  return { ok: true };
}
