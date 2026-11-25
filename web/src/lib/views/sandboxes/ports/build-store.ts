import type { SandboxVersion } from "../domain/version";

/** The build state of versions, for the build job. */
export interface BuildStore {
  /** `uploaded` to `building`. Null when the version has another status. */
  claim(projectId: string, versionId: string, now: Date): Promise<SandboxVersion | null>;
  heartbeat(versionId: string, now: Date): Promise<void>;
  /** Ends a build. It changes a version that is `building` only. */
  finish(versionId: string, outcome: BuildOutcome, now: Date): Promise<void>;
  /** Keeps an `uploaded` version unbuilt, with the reason. */
  leaveUnbuilt(projectId: string, versionId: string, reason: string): Promise<void>;
  /** The running build jobs whose build sent a heartbeat after `since`. */
  liveJobIds(since: Date): Promise<string[]>;
  /** Fails the builds with no heartbeat after `since`. Returns how many. */
  failStopped(since: Date, reason: string, now: Date): Promise<number>;
  /** The `uploaded` versions with no reason and no waiting job, created before `before`. */
  listUnqueued(before: Date): Promise<Array<{ projectId: string; versionId: string }>>;
}

export type BuildOutcome =
  | { status: "ready"; imageRef: string; log: string }
  | { status: "failed"; reason: string; log: string };
