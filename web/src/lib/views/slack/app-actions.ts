import type { Organization, OrgRole } from "@/lib/contracts/session";
import type { SlackAppCredentials } from "@/lib/contracts/slack-app";
import { CANNOT_STORE } from "@/lib/views/slack/types";

export type SlackAppInput = { orgSlug: string } & (
  | { action: "save"; clientId: string; clientSecret: string }
  | { action: "remove" }
);

export type SlackAppResult = { ok: true } | { ok: false; error: string };

export interface SlackAppAccessDeps {
  findOrganization(
    slug: string,
  ): Promise<{ organization: Organization; role: OrgRole; user: { externalId: string } } | null>;
  /** The edition supplies the app: nobody configures one. */
  editionOwned(): boolean;
}

export interface SlackAppDeps extends SlackAppAccessDeps {
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
  canSeal(): boolean;
  save(input: SlackAppCredentials & { organizationId: string; actor: string }): Promise<void>;
  remove(organizationId: string): Promise<void>;
  observe(fields: {
    organization_id: string;
    actor: string;
    action: SlackAppInput["action"];
  }): Promise<void>;
}

const CLIENT_ID = /^\d{5,20}\.\d{5,20}$/;
const CLIENT_SECRET = /^[A-Za-z0-9]{16,100}$/;
const INVALID = { ok: false, error: "The Slack app change is invalid." } as const;

/** Save or remove an organization's Slack app: its admins only. No result ever holds the secret. */
export async function changeSlackApp(raw: unknown, deps: SlackAppDeps): Promise<SlackAppResult> {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const { action } = input;
  if (typeof input.orgSlug !== "string" || (action !== "save" && action !== "remove"))
    return INVALID;
  const scope = await slackAppAdmin(input.orgSlug, deps);
  if (!scope) return { ok: false, error: "Only an organization admin can change the Slack app." };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change the Slack app." };
  const { organizationId, actor } = scope;

  if (action === "save") {
    const clientId = text(input.clientId);
    const clientSecret = text(input.clientSecret);
    if (!CLIENT_ID.test(clientId))
      return { ok: false, error: "Use the app's Client ID: two numbers with a dot between." };
    if (!CLIENT_SECRET.test(clientSecret))
      return { ok: false, error: "Use the app's Client Secret, under Basic Information in Slack." };
    if (!deps.canSeal()) return { ok: false, error: CANNOT_STORE };
    await deps.save({ organizationId, clientId, clientSecret, actor });
  } else {
    await deps.remove(organizationId);
  }
  await deps.observe({ organization_id: organizationId, actor, action });
  return { ok: true };
}

/** The reader as the one who may see and change the app; null for everyone else. */
export async function slackAppAdmin(
  orgSlug: string,
  deps: SlackAppAccessDeps,
): Promise<{ organizationId: string; actor: string } | null> {
  if (deps.editionOwned()) return null;
  const scope = await deps.findOrganization(orgSlug);
  if (scope?.role !== "admin") return null;
  return { organizationId: scope.organization.id, actor: scope.user.externalId };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}
