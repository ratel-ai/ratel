/**
 * Who is signed in, and the organization they act in. Identity is the edition's module: the
 * open-source edition answers with one local operator in one organization and reads no table;
 * the Cloud edition owns the users, organizations and memberships tables. The core keys its
 * own rows (projects and everything under them) on `Organization.id` and never reads those
 * tables.
 */
export type OrgRole = "admin" | "member";

/**
 * The fields the core reads. An edition may hand over a wider object (the Cloud adapter passes
 * its row, which the entitlements port reads plan columns from).
 */
export type Organization = {
  id: string;
  name: string;
  slug: string;
};

export type SessionUser = {
  /** The identity module's own id for this user. The core stores nothing keyed on it. */
  id: string;
  /** Stable across sessions: telemetry identity, rate-limit key, and the author of a change. */
  externalId: string;
  email: string | null;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export type SessionMembership = { organization: Organization; role: OrgRole };

export type Session = {
  user: SessionUser;
  /** The organization being viewed; always one of `memberships`. */
  organization: Organization;
  role: OrgRole;
  memberships: SessionMembership[];
};

/**
 * An operator acting inside another organization or as another user (Cloud support sessions).
 * `null` for everyone else. Writes are refused while one is active.
 */
export type ActingAs = {
  kind: "organization" | "user";
  targetId: string;
  readOnly: boolean;
} | null;

/** Where an edition keeps how the signed-in person left the guided tour (`SessionPort.tourStatus`). */
export type TourStatusStore = {
  /**
   * The stored status, as stored: the core reads it with `shouldOfferTour`, so an unknown value
   * offers the tour again. Null when the person has never finished it or nobody is signed in.
   */
  read(): Promise<string | null>;
  /** Records a finished ("completed") or dismissed ("skipped") tour. */
  write(status: "completed" | "skipped"): Promise<void>;
};

export type SessionPort = {
  /** Null when nobody is signed in. */
  resolveSession(): Promise<Session | null>;
  /** For paths with no session: API-key ingest and background jobs. */
  getOrganization(id: string): Promise<Organization | null>;
  /** For the `maxMembers` quota. */
  countMembers(organizationId: string): Promise<number>;
  actingAs(): Promise<ActingAs>;
  /**
   * Whether the request carries a support-session marker at all, valid or not. Upstream refuses
   * writes on the marker alone, so a stale or forged one still restricts; `actingAs` answers only
   * for a session it could resolve. Absent: only `actingAs` decides.
   */
  supportSessionPresent?(): Promise<boolean>;
  /**
   * Remembers the project the reader just opened, called by the project layout after the reader
   * may see it. The edition decides where it is kept and when it is not written (Cloud keeps a
   * pointer on the user row and writes nothing in a support session). Absent, nothing is
   * remembered beyond the last-project cookie.
   */
  rememberProject?(projectId: string): Promise<void>;
  /**
   * The project the signed-in person last opened, as the edition remembers it (Cloud: the user
   * row's pointer), or null when it has none. Read when the last-project cookie names no project
   * the reader may see (a new browser): `/project/_/…` links and the console entry land there.
   * Absent, they land on the active organization's first project.
   */
  lastProject?(): Promise<string | null>;
  /**
   * How the signed-in person left the guided tour, kept with their account. The edition decides
   * where and when it is not written (Cloud keeps it on the user row and writes nothing in a
   * support session). Absent, the core keeps it in a per-browser cookie.
   */
  tourStatus?: TourStatusStore;
  /** Throws when the deployment cannot authenticate anyone. Called once, at boot. */
  assertConfigured?(): void;
};

/**
 * What an edition's refused support-session write throws with (upstream's `SUPPORT_BLOCKED_MESSAGE`,
 * `lib/admin/support/policy.ts`), so the core's error boundaries tell it from a fault: the
 * product working, not something to report.
 */
export const SUPPORT_BLOCKED_MESSAGE =
  "We couldn't do that: this is a read-only admin support session. Nothing was changed.";

/** Whether an error is a refused support-session write rather than a fault. */
export function isSupportBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(SUPPORT_BLOCKED_MESSAGE);
}
