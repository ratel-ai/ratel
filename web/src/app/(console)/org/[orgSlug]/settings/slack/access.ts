import { composition } from "@/lib/composition/ports";
import { findOrganizationScope } from "@/lib/console/scope/organization-scope";
import { featureEnabled } from "@/lib/platform/experimental-features";
import type { SlackAppAccessDeps } from "@/lib/views/slack/app-actions";

/** Who may see and change the organization's Slack app. */
export const slackAppAccess: SlackAppAccessDeps = {
  findOrganization: (slug) => findOrganizationScope(slug),
  enabled: (subject) => featureEnabled("customMonitoring", subject),
  editionOwned: () => composition.slackApp !== undefined,
};
