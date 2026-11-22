import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import type { GitHubPort, GitHubRepo } from "./ports";
import {
  signInstallGrant,
  signSetupState,
  verifyInstallGrant,
  verifySetupState,
} from "./setup-state";

/**
 * Linking a project to a GitHub repo (RC-914, RC-958): Install, GitHub's
 * redirect back, the repo picker, Link and Unlink. Each step checks, before
 * any write, that the signed-in person can reach the project and that
 * `FF_CODE_HANDOFF` is on for it. Install, Link and Unlink are refused in
 * an admin support session: a link outlives the session.
 *
 * Nothing on GitHub's redirect is trusted as it stands: anyone can put any
 * `installation_id` on it. The App asks for user authorization during install,
 * so the redirect carries the person's `code`. The setup step trades it for a
 * user access token, asks GitHub which installations that person can reach
 * (`GET /user/installations`), drops the token, and grants only those. The
 * signed state binds the Ratel person and the project.
 */

/** Who acts and on which project. `externalId` is the signed-in person. */
export interface LinkActor {
  projectId: string;
  externalId: string;
}

export interface LinkServiceDeps {
  /** The webhook secret that keys the setup state, or null when the App is not fully configured. */
  secret: string | null;
  github: GitHubPort;
  /** The project's organization when the signed-in person can reach it, else null. */
  projectAccess: (projectId: string) => Promise<{ organizationId: string } | null>;
  flagEnabled: (projectId: string) => Promise<boolean>;
  /** True in an admin support session, which must not leave a link behind. */
  isRestricted: () => Promise<boolean>;
  getRepoLink: (projectId: string) => Promise<RepoLinkRow | null>;
  linkRepo: (link: Omit<RepoLinkRow, "id" | "createdAt">) => Promise<RepoLinkRow>;
  unlinkRepo: (projectId: string) => Promise<boolean>;
  track: (
    event: "repo_linked" | "repo_unlinked",
    context: { externalId: string; projectId: string; orgId: string },
    properties: Record<string, unknown>,
  ) => Promise<void>;
  /** Structured log line. Never pass a token or a code. */
  log: (fields: Record<string, unknown>, message: string) => void;
  now: () => number;
}

export type LinkError =
  | "not_configured"
  | "forbidden"
  | "flag_off"
  | "support_session"
  | "invalid_state"
  | "wrong_user"
  | "unknown_installation"
  | "unverified_installation"
  | "invalid_grant"
  | "repo_not_found";

export type Result<T> = ({ ok: true } & T) | { ok: false; error: LinkError };

/** A setup error names the project once the state was good, so the person lands back on its tab. */
export type SetupResult =
  | { ok: true; projectId: string; grant: string }
  | { ok: false; error: LinkError; projectId?: string };

/** A repo the picker offers, with the installation that reaches it. */
export type GrantRepo = GitHubRepo & { installationId: number };

/** The `state` for the Install link of this project and person. */
export async function startInstall(
  actor: LinkActor,
  deps: LinkServiceDeps,
): Promise<Result<{ state: string }>> {
  if (await deps.isRestricted()) return { ok: false, error: "support_session" };
  const gate = await checkGate(actor.projectId, deps);
  if (!gate.ok) return gate;
  return { ok: true, state: signSetupState(actor, gate.secret, deps.now()) };
}

/**
 * GitHub's redirect after install and user authorization: the `state` on the
 * URL must be there and equal the install cookie, else a link made by someone
 * else (with their own `code`) could ride the person's cookie. Then check the
 * state and grant only the installations the person can reach on GitHub. When the
 * redirect names an installation it must be one of them. Writes nothing.
 */
export async function completeSetup(
  input: {
    state: string | null;
    cookieState: string | null;
    code: string | null;
    installationId: string | null;
    externalId: string;
  },
  deps: LinkServiceDeps,
): Promise<SetupResult> {
  if (!deps.secret) return { ok: false, error: "not_configured" };
  if (!input.state || input.state !== input.cookieState) return refuse(deps, "invalid_state");
  const now = deps.now();
  const state = verifySetupState(input.state, deps.secret, now);
  if (!state) return refuse(deps, "invalid_state");
  if (state.externalId !== input.externalId) return refuse(deps, "wrong_user");
  const gate = await checkGate(state.projectId, deps);
  if (!gate.ok) return refuse(deps, gate.error, state.projectId);

  const reachable = await reachableInstallations(input.code, deps);
  if (!reachable) return refuse(deps, "unverified_installation", state.projectId);
  let installationIds = reachable;
  if (input.installationId) {
    const named = Number(input.installationId);
    if (!reachable.includes(named)) return refuse(deps, "unverified_installation", state.projectId);
    installationIds = [named];
  }
  if (installationIds.length === 0) return refuse(deps, "unknown_installation", state.projectId);

  deps.log(
    { project_id: state.projectId, installations: installationIds.length },
    "granted github installations",
  );
  return {
    ok: true,
    projectId: state.projectId,
    grant: signInstallGrant({ ...state, installationIds }, deps.secret, now),
  };
}

/** The repos the picker offers for a grant, across its installations. */
export async function listGrantRepos(
  actor: LinkActor,
  grant: string,
  deps: LinkServiceDeps,
): Promise<Result<{ repos: GrantRepo[] }>> {
  const checked = await checkGrant(actor, grant, deps);
  if (!checked.ok) return checked;
  return { ok: true, repos: await grantRepos(checked.installationIds, deps) };
}

/**
 * Link the picked repo. Emits `repo_linked` only when the project had no
 * link or had another repo: linking the same repo again is quiet.
 */
export async function linkProjectRepo(
  actor: LinkActor,
  input: { grant: string; repoId: number },
  deps: LinkServiceDeps,
): Promise<Result<{ link: RepoLinkRow }>> {
  if (await deps.isRestricted()) return { ok: false, error: "support_session" };
  const checked = await checkGrant(actor, input.grant, deps);
  if (!checked.ok) return checked;
  const repo = (await grantRepos(checked.installationIds, deps)).find(
    (candidate) => candidate.id === input.repoId,
  );
  if (!repo) return { ok: false, error: "repo_not_found" };
  const previous = await deps.getRepoLink(actor.projectId);
  const link = await deps.linkRepo({
    projectId: actor.projectId,
    installationId: repo.installationId,
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    linkedBy: actor.externalId,
  });
  if (previous?.repoId !== repo.id) {
    await deps.track(
      "repo_linked",
      { externalId: actor.externalId, projectId: actor.projectId, orgId: checked.organizationId },
      { repo_id: repo.id, installation_id: repo.installationId },
    );
  }
  return { ok: true, link };
}

/** Remove the project's link. Emits `repo_unlinked` when there was one. */
export async function unlinkProjectRepo(
  actor: LinkActor,
  deps: LinkServiceDeps,
): Promise<Result<{ removed: boolean }>> {
  if (await deps.isRestricted()) return { ok: false, error: "support_session" };
  const gate = await checkGate(actor.projectId, deps, { configured: false });
  if (!gate.ok) return gate;
  const existing = await deps.getRepoLink(actor.projectId);
  const removed = await deps.unlinkRepo(actor.projectId);
  if (removed) {
    await deps.track(
      "repo_unlinked",
      { externalId: actor.externalId, projectId: actor.projectId, orgId: gate.organizationId },
      { repo_id: existing?.repoId ?? null },
    );
  }
  return { ok: true, removed };
}

/** Access first, then the flag, then (unless asked not to) the App's configuration. */
async function checkGate(
  projectId: string,
  deps: LinkServiceDeps,
  options: { configured: boolean } = { configured: true },
): Promise<{ ok: true; secret: string; organizationId: string } | { ok: false; error: LinkError }> {
  const access = await deps.projectAccess(projectId);
  if (!access) return { ok: false, error: "forbidden" };
  if (!(await deps.flagEnabled(projectId))) return { ok: false, error: "flag_off" };
  if (options.configured && !deps.secret) return { ok: false, error: "not_configured" };
  return { ok: true, secret: deps.secret ?? "", organizationId: access.organizationId };
}

/** A grant made by the setup step for this person and project, still in date. */
async function checkGrant(
  actor: LinkActor,
  grant: string,
  deps: LinkServiceDeps,
): Promise<
  { ok: true; installationIds: number[]; organizationId: string } | { ok: false; error: LinkError }
> {
  const gate = await checkGate(actor.projectId, deps);
  if (!gate.ok) return gate;
  const verified = verifyInstallGrant(grant, gate.secret, deps.now());
  if (
    !verified ||
    verified.projectId !== actor.projectId ||
    verified.externalId !== actor.externalId
  )
    return { ok: false, error: "invalid_grant" };
  return {
    ok: true,
    installationIds: verified.installationIds,
    organizationId: gate.organizationId,
  };
}

/**
 * The installations the person behind `code` can reach, or null when GitHub
 * gives no token for it. The token lives only inside this function.
 */
async function reachableInstallations(
  code: string | null,
  deps: LinkServiceDeps,
): Promise<number[] | null> {
  if (!code) return null;
  const userToken = await deps.github.exchangeUserCode(code);
  if (!userToken) return null;
  return deps.github.listUserInstallations(userToken);
}

async function grantRepos(installationIds: number[], deps: LinkServiceDeps): Promise<GrantRepo[]> {
  const lists = await Promise.all(
    installationIds.map(async (installationId) =>
      (await deps.github.listInstallationRepos(installationId)).map((repo) => ({
        ...repo,
        installationId,
      })),
    ),
  );
  return lists.flat();
}

function refuse(deps: LinkServiceDeps, error: LinkError, projectId?: string): SetupResult {
  deps.log({ error, ...(projectId ? { project_id: projectId } : {}) }, "refused github app setup");
  return projectId ? { ok: false, error, projectId } : { ok: false, error };
}
