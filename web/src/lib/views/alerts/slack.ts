import {
  recordAccess,
  type SealedChannel,
  type SealedDestination,
  type SealedWebhook,
  sealedDestinationsOfRule,
  webhookOf,
} from "@/lib/views/alerts/destinations";
import { alertHref } from "@/lib/views/alerts/links";
import type { AlertNotice, AlertNotifier } from "@/lib/views/alerts/notifier";
import { slackMessage } from "@/lib/views/alerts/slack-message";
import { type PostResult, type PostWebhook, postWebhook } from "@/lib/views/alerts/webhook-post";
import { deploymentOrigin } from "@/lib/views/slack/app";
import { postToChannel, type SlackWorkspaceDeps } from "@/lib/views/slack/channels";
import { isChannelError, slackErrorText } from "@/lib/views/slack/errors";
import { slackWorkspace } from "@/lib/views/slack/workspace";

export interface SlackDeps extends PostDeps {
  destinationsOf(ruleId: string): Promise<SealedDestination[]>;
  /** This deployment's origin, for the link. */
  baseUrl: string;
}

/** How a message leaves: by webhook, or by the organization's Slack app. */
export interface PostDeps {
  post: PostWebhook;
  workspace: SlackWorkspaceDeps;
  /** Keeps why the app could not post to a channel; null: it could. */
  recordAccess(destinationId: string, accessError: string | null): Promise<void>;
  /** The secret key of the webhook URLs; the configuration's by default. */
  key?: string;
}

/** The notifier that posts to the Slack destinations of the rule, each on its own. */
export function slackNotifier(deps?: SlackDeps): AlertNotifier {
  return {
    async send(notice: AlertNotice) {
      const all = deps ?? defaultDeps();
      const destinations = await all.destinationsOf(notice.ruleId);
      const message = slackMessage(
        notice,
        `${all.baseUrl}${alertHref(notice.projectId, notice.ruleId)}`,
      );
      const sentTo = [...notice.sentTo];
      const errors: string[] = [];
      await Promise.all(
        destinations.map(async (destination) => {
          if (notice.sentTo.includes(destination.id)) return;
          const result = await postTo(destination, message, all);
          if (result.ok) sentTo.push(destination.id);
          else errors.push(`${destination.name}: ${result.error}`);
        }),
      );
      return { sentTo, error: errors.length > 0 ? errors.join(" ") : null };
    },
  };
}

/** Open, check and post. Never throws, and its error never holds a secret. */
export async function postTo(
  destination: SealedDestination,
  message: { text: string },
  deps: PostDeps = defaultPost(),
): Promise<PostResult> {
  return destination.kind === "webhook"
    ? postToWebhook(destination, message, deps)
    : postByApp(destination, message, deps);
}

async function postByApp(
  destination: SealedChannel,
  message: { text: string },
  deps: PostDeps,
): Promise<PostResult> {
  let result: Awaited<ReturnType<typeof postToChannel>>;
  try {
    result = await postToChannel(destination, message, deps.workspace);
  } catch {
    return { ok: false, error: "The message could not be sent." };
  }
  // A failed write must not repeat a message that arrived.
  const keep = (accessError: string | null) =>
    deps.recordAccess(destination.id, accessError).catch(() => {});
  if (result.ok) {
    if (destination.accessError !== null) await keep(null);
    return result;
  }
  if (isChannelError(result.code)) await keep(result.code);
  return { ok: false, error: slackErrorText(result.code) };
}

async function postToWebhook(
  destination: SealedWebhook,
  message: { text: string },
  { post, key }: PostDeps,
): Promise<PostResult> {
  let url: URL | null;
  try {
    url = webhookOf(destination, key);
  } catch {
    return {
      ok: false,
      error: "The stored webhook URL cannot be opened. Was RATEL_SECRET_KEY changed?",
    };
  }
  if (!url) return { ok: false, error: "The stored webhook URL is not a Slack address." };
  return post(url, message);
}

function defaultPost(): PostDeps {
  return {
    post: (url, body) => postWebhook(url, body),
    workspace: slackWorkspace(),
    recordAccess: (id, accessError) => recordAccess(id, accessError),
  };
}

function defaultDeps(): SlackDeps {
  return {
    ...defaultPost(),
    destinationsOf: (ruleId) => sealedDestinationsOfRule(ruleId),
    baseUrl: deploymentOrigin(),
  };
}
