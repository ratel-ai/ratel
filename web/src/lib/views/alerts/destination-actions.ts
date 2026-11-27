import { parseProjectUuid } from "@/lib/console/scope/cookie";
import {
  type AlertAccessDeps,
  type AlertSubject,
  authorizeAlerts,
} from "@/lib/views/alerts/actions";
import {
  type DestinationRefusal,
  MAX_DESTINATIONS,
  type SealedDestination,
} from "@/lib/views/alerts/destinations";
import { slackTestMessage } from "@/lib/views/alerts/slack-message";
import { parseSlackWebhook } from "@/lib/views/alerts/slack-url";
import { MAX_DESTINATION_NAME } from "@/lib/views/alerts/types";
import type { PostResult } from "@/lib/views/alerts/webhook-post";
import { type ChannelAccess, parseChannelId } from "@/lib/views/slack/channels";
import { isChannelError, slackErrorText } from "@/lib/views/slack/errors";

export type DestinationActionInput = { projectId: string } & (
  | { action: "add"; name: string; url: string }
  | { action: "add_channel"; channelId: string }
  | { action: "test"; destinationId: string }
  | { action: "remove"; destinationId: string }
);

export type DestinationActionResult =
  /** `warning`: it is saved, and the app cannot post there yet. */
  { ok: true; destinationId: string; warning?: string } | { ok: false; error: string };

export interface DestinationActionDeps extends AlertAccessDeps {
  /** Whether this deployment can keep secrets. */
  canSeal(): boolean;
  /** "limit" when the project has `MAX_DESTINATIONS`, counted with the insert. */
  create(input: {
    projectId: string;
    name: string;
    url: URL;
    actor: string;
  }): Promise<string | "limit">;
  /** Whether the app can post to a channel of the organization's workspace. */
  channelAccess(organizationId: string, channelId: string): Promise<ChannelAccess>;
  /** "taken" when the project has the channel already, "limit" as for `create`. */
  createChannel(input: {
    projectId: string;
    name: string;
    teamId: string;
    channelId: string;
    accessError: string | null;
    actor: string;
  }): Promise<string | DestinationRefusal>;
  remove(projectId: string, id: string): Promise<boolean>;
  sealed(projectId: string, id: string): Promise<SealedDestination | null>;
  post(destination: SealedDestination, message: { text: string }): Promise<PostResult>;
  projectName(projectId: string): Promise<string>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    destination_id: string;
    actor: string;
    action: DestinationActionInput["action"];
    outcome: "ok" | "failed";
  }): Promise<void>;
}

const INVALID = { ok: false, error: "The destination is invalid." } as const;
const MISSING = { ok: false, error: "This destination no longer exists." } as const;
const FULL = {
  ok: false,
  error: `A project can have ${MAX_DESTINATIONS} destinations.`,
} as const;

/** Add, test or remove a Slack destination. No result ever holds a secret. */
export async function changeDestination(
  raw: unknown,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const access = await authorizeAlerts(input.projectId, deps);
  if (!access.ok) return access;
  const { subject } = access;
  const { action } = input;
  if (action !== "add" && action !== "add_channel" && action !== "test" && action !== "remove")
    return INVALID;

  const id = text(input.destinationId);
  const result =
    action === "add"
      ? await add(input, subject, deps)
      : action === "add_channel"
        ? await addChannel(input, subject, deps)
        : !id
          ? INVALID
          : action === "test"
            ? await sendTest(id, subject, deps)
            : (await deps.remove(subject.projectId, id))
              ? { ok: true as const, destinationId: id }
              : MISSING;
  const destinationId = result.ok ? result.destinationId : id;
  if (destinationId)
    await deps.observe({
      project_id: subject.projectId,
      organization_id: subject.organizationId,
      destination_id: destinationId,
      actor: subject.actor,
      action,
      outcome: result.ok ? "ok" : "failed",
    });
  return result;
}

async function add(
  input: Record<string, unknown>,
  { projectId, actor }: AlertSubject,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the destination a name." };
  if (name.length > MAX_DESTINATION_NAME)
    return { ok: false, error: `A name can have ${MAX_DESTINATION_NAME} characters.` };
  const url = parseSlackWebhook(input.url);
  if (!url)
    return {
      ok: false,
      error: "Use an incoming webhook URL that starts with https://hooks.slack.com/.",
    };
  if (!deps.canSeal())
    return {
      ok: false,
      error: "This deployment cannot store secrets. Set RATEL_SECRET_KEY and restart it.",
    };
  const created = await deps.create({ projectId, name, url, actor });
  return created === "limit" ? FULL : { ok: true, destinationId: created };
}

/** A channel without access is saved too, with what to do: people invite the app next. */
async function addChannel(
  input: Record<string, unknown>,
  { projectId, organizationId, actor }: AlertSubject,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const channelId = parseChannelId(input.channelId);
  if (!channelId) return { ok: false, error: "Pick a channel, or enter a channel ID." };
  const access = await deps.channelAccess(organizationId, channelId);
  const accessError = access.ok ? null : access.code;
  if (accessError !== null && !isChannelError(accessError))
    return { ok: false, error: slackErrorText(accessError) };
  if (!access.teamId) return INVALID;
  const name = access.name ? `#${access.name}` : channelId;
  const destinationId = await deps.createChannel({
    projectId,
    name: name.slice(0, MAX_DESTINATION_NAME),
    teamId: access.teamId,
    channelId,
    accessError,
    actor,
  });
  if (destinationId === "limit") return FULL;
  if (destinationId === "taken")
    return { ok: false, error: "This channel is already a destination." };
  return accessError === null
    ? { ok: true, destinationId }
    : { ok: true, destinationId, warning: slackErrorText(accessError) };
}

async function sendTest(
  id: string,
  { projectId }: AlertSubject,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const destination = await deps.sealed(projectId, id);
  if (!destination) return MISSING;
  const message = slackTestMessage(destination.name, await deps.projectName(projectId));
  const result = await deps.post(destination, message);
  return result.ok ? { ok: true, destinationId: id } : result;
}

function text(raw: unknown): string | null {
  return typeof raw === "string" ? parseProjectUuid(raw) : null;
}
