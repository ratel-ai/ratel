import type { OrgRole } from "@/lib/contracts/session";
import type { SlackAppCredentials } from "@/lib/contracts/slack-app";
import { SecretBoxError } from "@/lib/platform/secret-box";
import { type AlertAccessDeps, authorizeAlerts } from "@/lib/views/alerts/actions";
import type { CallSlack } from "@/lib/views/slack/api";
import { SLACK_BOT_SCOPES, slackAuthorizeUrl } from "@/lib/views/slack/app";
import { makeState, readState } from "@/lib/views/slack/state";
import type { SaveOutcome } from "@/lib/views/slack/store";
import {
  CANNOT_STORE,
  INSTALL_NOTICES,
  type InstallNotice,
  NOT_ADMIN,
  SLACK_UNAVAILABLE,
  type SlackConnection,
} from "@/lib/views/slack/types";

export interface InstallDeps extends AlertAccessDeps {
  role(projectId: string): Promise<OrgRole | null>;
  app(organizationId: string): Promise<SlackAppCredentials | null>;
  connection(organizationId: string): Promise<SlackConnection | null>;
  /** The edition supplies the app: nobody configures one. */
  editionOwned: boolean;
  /** Whether this deployment can keep secrets. */
  canSeal(): boolean;
  call: CallSlack;
  save(input: {
    organizationId: string;
    teamId: string;
    teamName: string;
    token: string;
    actor: string;
  }): Promise<SaveOutcome>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    actor: string;
    outcome: InstallNotice;
    /** Slack's own code of a refusal. */
    code?: string;
  }): Promise<void>;
  redirectUrl: string;
  slackUrl: string;
  now?: () => Date;
  /** The secret key; the configuration's by default. */
  key?: string;
}

type Refused = { ok: false; status: number; error: string };
export type StartResult = { ok: true; location: string } | Refused;
export type FinishResult =
  | { ok: true; projectId: string; notice: InstallNotice; code?: string }
  | Refused;

const NOT_CONFIGURED =
  "No Slack app is configured. An organization admin can add one in the organization settings, under Slack.";
const BAD_STATE =
  "This Slack install link is not valid any more. Open Settings, Notifications and click Add to Slack again.";

/** Where to send the person who clicked Add to Slack. */
export async function startInstall(rawProjectId: unknown, deps: InstallDeps): Promise<StartResult> {
  const access = await authorizeAlerts(rawProjectId, deps);
  if (!access.ok) return refused(403, access.error);
  const { subject } = access;
  if (!(await isAdmin(subject.projectId, deps))) return refused(403, NOT_ADMIN);
  if (!deps.canSeal()) return refused(409, CANNOT_STORE);
  const app = await usableApp(subject.organizationId, deps);
  if (!app) return refused(409, deps.editionOwned ? SLACK_UNAVAILABLE : NOT_CONFIGURED);
  if (await live(subject.organizationId, deps))
    return refused(409, INSTALL_NOTICES.already_connected);
  const state = makeState(subject, deps.now?.(), deps.key);
  return { ok: true, location: slackAuthorizeUrl(app.clientId, state, deps) };
}

/**
 * What Slack sent the person back with. Without a state that this deployment made for this person
 * in the last 10 minutes, nothing is exchanged and nothing is stored.
 */
export async function finishInstall(
  query: { state: string | null; code: string | null; error: string | null },
  deps: InstallDeps,
): Promise<FinishResult> {
  const state = readState(query.state, deps.now?.(), deps.key);
  if (!state) return refused(400, BAD_STATE);
  const access = await authorizeAlerts(state.projectId, deps);
  if (!access.ok) return refused(403, access.error);
  const { subject } = access;
  if (subject.actor !== state.actor || subject.organizationId !== state.organizationId)
    return refused(400, BAD_STATE);
  if (!(await isAdmin(subject.projectId, deps))) return refused(403, NOT_ADMIN);

  const { notice, code } = await install(query, subject, deps);
  await deps.observe({
    project_id: subject.projectId,
    organization_id: subject.organizationId,
    actor: subject.actor,
    outcome: notice,
    ...(code ? { code } : {}),
  });
  return { ok: true, projectId: subject.projectId, notice, ...(code ? { code } : {}) };
}

async function install(
  query: { code: string | null; error: string | null },
  { organizationId, actor }: { organizationId: string; actor: string },
  deps: InstallDeps,
): Promise<{ notice: InstallNotice; code?: string }> {
  if (query.error === "access_denied") return { notice: "denied" };
  if (query.error || !query.code) return { notice: "failed" };
  if (await live(organizationId, deps)) return { notice: "already_connected" };
  const app = await usableApp(organizationId, deps);
  if (!app) return { notice: "not_configured" };

  const answer = await deps.call({
    method: "oauth.v2.access",
    params: { code: query.code, redirect_uri: deps.redirectUrl },
    auth: app,
  });
  if (!answer.ok) return { notice: "failed", code: answer.code };
  const { access_token: token, refresh_token: rotating, team, scope } = answer.data;
  if (typeof token !== "string" || !token) return { notice: "failed" };
  /** Nobody can disconnect a token that Ratel does not keep. */
  const refuse = async (notice: InstallNotice) => {
    await deps.call({ method: "auth.revoke", auth: { token } });
    return { notice };
  };
  // Such a token ends after 12 hours.
  if (rotating) return refuse("rotation");
  const { id: teamId, name: teamName } = (team ?? {}) as { id?: unknown; name?: unknown };
  if (typeof teamId !== "string" || !teamId) return refuse("no_workspace");
  const granted = typeof scope === "string" ? scope.split(",") : [];
  if (SLACK_BOT_SCOPES.some((needed) => !granted.includes(needed))) return refuse("no_scopes");
  let outcome: SaveOutcome;
  try {
    outcome = await deps.save({
      organizationId,
      teamId,
      teamName: typeof teamName === "string" && teamName ? teamName : teamId,
      token,
      actor,
    });
  } catch (error) {
    await refuse("failed");
    throw error;
  }
  // Another callback connected the organization meanwhile. Slack may give both the same token.
  if (outcome === "taken") return refuse("already_connected");
  return { notice: outcome === "saved" ? "connected" : "already_connected" };
}

async function isAdmin(projectId: string, deps: InstallDeps): Promise<boolean> {
  return (await deps.role(projectId)) === "admin";
}

/** A lost connection may be replaced; a live one must be disconnected first. */
async function live(organizationId: string, deps: InstallDeps): Promise<boolean> {
  const connection = await deps.connection(organizationId);
  return connection !== null && !connection.lost;
}

/** A saved secret that cannot be opened (another key) is no app: it must be saved again. */
async function usableApp(
  organizationId: string,
  deps: InstallDeps,
): Promise<SlackAppCredentials | null> {
  try {
    return await deps.app(organizationId);
  } catch (error) {
    if (error instanceof SecretBoxError) return null;
    throw error;
  }
}

function refused(status: number, error: string): Refused {
  return { ok: false, status, error };
}
