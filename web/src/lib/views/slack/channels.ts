import type { CallSlack } from "@/lib/views/slack/api";
import { isLostConnection } from "@/lib/views/slack/errors";
import { botTokenOf, type SealedSlackConnection } from "@/lib/views/slack/store";

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

/** One organization's workspace, as the app reaches it. */
export interface SlackWorkspaceDeps {
  connection(organizationId: string): Promise<SealedSlackConnection | null>;
  markLost(connection: SealedSlackConnection): Promise<void>;
  call: CallSlack;
  /** The secret key; the configuration's by default. */
  key?: string;
}

export type ChannelList =
  /** `partial`: the workspace has more, or Slack stopped answering. */
  { ok: true; channels: SlackChannel[]; partial: boolean } | { ok: false; code: string };

export type ChannelAccess =
  | { ok: true; teamId: string; name: string }
  /** `name` when Slack shows the channel though the app cannot post to it. */
  | { ok: false; code: string; teamId?: string; name?: string };

const PAGE = 999;
const MAX_PAGES = 10;
const CHANNEL_ID = /^[CG][A-Z0-9]{6,20}$/;

/** A channel's id, as Slack writes it, or null. */
export function parseChannelId(raw: unknown): string | null {
  return typeof raw === "string" && CHANNEL_ID.test(raw.trim()) ? raw.trim() : null;
}

/** The public channels, and the private ones the app is in, by name. */
export async function listChannels(
  organizationId: string,
  deps: SlackWorkspaceDeps,
): Promise<ChannelList> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await callWorkspace(organizationId, "conversations.list", deps, {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(PAGE),
      ...(cursor ? { cursor } : {}),
    });
    if (!answer.ok) {
      if (page === 0) return { ok: false, code: answer.code };
      return { ok: true, channels: byName(channels), partial: true };
    }
    for (const raw of Array.isArray(answer.data.channels) ? answer.data.channels : []) {
      const channel = channelOf(raw);
      if (channel) channels.push(channel);
    }
    cursor = nextCursor(answer.data);
    if (!cursor) return { ok: true, channels: byName(channels), partial: false };
  }
  return { ok: true, channels: byName(channels), partial: true };
}

/** Whether the app can post to a channel, without posting. */
export async function channelAccess(
  organizationId: string,
  channelId: string,
  deps: SlackWorkspaceDeps,
): Promise<ChannelAccess> {
  const answer = await callWorkspace(organizationId, "conversations.info", deps, {
    channel: channelId,
  });
  if (!answer.ok) return { ok: false, code: answer.code, teamId: answer.teamId };
  const { teamId } = answer;
  const channel = (answer.data.channel ?? {}) as Record<string, unknown>;
  const name = typeof channel.name === "string" ? channel.name : channelId;
  if (channel.is_archived === true) return { ok: false, code: "is_archived", teamId, name };
  // `chat:write.public` reaches a public channel of this workspace only.
  const open = channel.is_private !== true && channel.is_ext_shared !== true;
  if (!open && channel.is_member !== true)
    return { ok: false, code: "not_in_channel", teamId, name };
  return { ok: true, teamId, name };
}

/** Posts as the app. */
export async function postToChannel(
  {
    organizationId,
    teamId,
    channelId,
  }: {
    organizationId: string;
    teamId: string;
    channelId: string;
  },
  message: { text: string },
  deps: SlackWorkspaceDeps,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const answer = await callWorkspace(
    organizationId,
    "chat.postMessage",
    deps,
    { channel: channelId, text: message.text, unfurl_links: "false" },
    teamId,
  );
  return answer.ok ? { ok: true } : { ok: false, code: answer.code };
}

/** Asks Slack to end the token, at best. */
export async function revokeToken(organizationId: string, deps: SlackWorkspaceDeps): Promise<void> {
  await callWorkspace(organizationId, "auth.revoke", deps, {});
}

type WorkspaceAnswer =
  | { ok: true; data: Record<string, unknown>; teamId: string }
  | { ok: false; code: string; teamId?: string };

/**
 * One call with the organization's bot token. A refusal of the token marks the connection as lost.
 * With `teamId`, only that workspace is called.
 */
async function callWorkspace(
  organizationId: string,
  method: string,
  deps: SlackWorkspaceDeps,
  params: Record<string, string>,
  teamId?: string,
): Promise<WorkspaceAnswer> {
  const connection = await deps.connection(organizationId);
  if (!connection) return { ok: false, code: "not_connected" };
  if (teamId !== undefined && connection.teamId !== teamId)
    return { ok: false, code: "other_workspace" };
  let token: string;
  try {
    token = botTokenOf(connection, deps.key);
  } catch {
    // Another RATEL_SECRET_KEY: only a new install can help.
    return { ok: false, code: "invalid_auth" };
  }
  const answer = await deps.call({ method, params, auth: { token } });
  if (!answer.ok && isLostConnection(answer.code)) await deps.markLost(connection);
  return { ...answer, teamId: connection.teamId };
}

function channelOf(raw: unknown): SlackChannel | null {
  const { id, name, is_private } = (raw ?? {}) as Record<string, unknown>;
  if (!parseChannelId(id) || typeof name !== "string") return null;
  return { id: id as string, name, isPrivate: is_private === true };
}

function nextCursor(data: Record<string, unknown>): string {
  const metadata = (data.response_metadata ?? {}) as { next_cursor?: unknown };
  return typeof metadata.next_cursor === "string" ? metadata.next_cursor : "";
}

function byName(channels: SlackChannel[]): SlackChannel[] {
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}
