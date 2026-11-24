import { getConfig } from "@/config";
import {
  type SealedDestination,
  sealedDestinationsOfRule,
  webhookOf,
} from "@/lib/views/alerts/destinations";
import { alertHref } from "@/lib/views/alerts/links";
import type { AlertNotice, AlertNotifier } from "@/lib/views/alerts/notifier";
import { slackMessage } from "@/lib/views/alerts/slack-message";
import { type PostResult, type PostWebhook, postWebhook } from "@/lib/views/alerts/webhook-post";

export interface SlackDeps {
  destinationsOf(ruleId: string): Promise<SealedDestination[]>;
  post: PostWebhook;
  /** This deployment's origin, for the link. */
  baseUrl: string;
  /** The secret key; the configuration's by default. */
  key?: string;
}

/** The notifier that posts to the Slack destinations of the rule, each on its own. */
export function slackNotifier(deps?: SlackDeps): AlertNotifier {
  return {
    async send(notice: AlertNotice) {
      const { destinationsOf, post, baseUrl, key } = deps ?? defaultDeps();
      const destinations = await destinationsOf(notice.ruleId);
      const message = slackMessage(
        notice,
        `${baseUrl}${alertHref(notice.projectId, notice.ruleId)}`,
      );
      const sentTo = [...notice.sentTo];
      const errors: string[] = [];
      await Promise.all(
        destinations.map(async (destination) => {
          if (notice.sentTo.includes(destination.id)) return;
          const result = await postTo(destination, message, post, key);
          if (result.ok) sentTo.push(destination.id);
          else errors.push(`${destination.name}: ${result.error}`);
        }),
      );
      return { sentTo, error: errors.length > 0 ? errors.join(" ") : null };
    },
  };
}

/** Open, check and post. Never throws, and its error never holds the URL. */
export async function postTo(
  destination: SealedDestination,
  message: { text: string },
  post: PostWebhook = postWebhook,
  key?: string,
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

function defaultDeps(): SlackDeps {
  const { publicUrl, baseUrl } = getConfig().app;
  return {
    destinationsOf: (ruleId) => sealedDestinationsOfRule(ruleId),
    post: (url, body) => postWebhook(url, body),
    baseUrl: (publicUrl || baseUrl).replace(/\/+$/, ""),
  };
}
