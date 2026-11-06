import { sessionReplayEnabled } from "@/lib/views/session-replay-flag";

/**
 * Whether session replay (RC-144: the session timeline, context lens, decision chips and
 * What-if) is on for a project.
 *
 * Owned (ADR-0030): one switch for the deployment, `FF_SESSION_REPLAY`, read by
 * `views/session-replay-flag.ts` and off by default. Upstream decides it per organization and
 * person through its flag service; the function keeps upstream's name and arguments so the
 * What-if call sites (`runs.ts`, `job.ts`) stay identical, and ignores who is asking.
 */

type Env = Record<string, string | undefined>;

/** Upstream's flag-service dependencies; here, the environment the flag is read from. */
export type OrganizationFlagDeps = Env;

export const defaultOrganizationFlagDeps: OrganizationFlagDeps = process.env;

/**
 * The flag for whoever asked: a person, an API key (`project:<id>`) or a system run. Every
 * one of them gets the deployment's switch.
 */
export function sessionReplayEnabledForActor(
  _projectId: string,
  _actor: string,
  _db?: unknown,
  deps: OrganizationFlagDeps = defaultOrganizationFlagDeps,
): Promise<boolean> {
  return Promise.resolve(sessionReplayEnabled(deps));
}
