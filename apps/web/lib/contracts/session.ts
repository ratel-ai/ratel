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

export type SessionPort = {
  /** Null when nobody is signed in. */
  resolveSession(): Promise<Session | null>;
  /** For paths with no session: API-key ingest and background jobs. */
  getOrganization(id: string): Promise<Organization | null>;
  /** For the `maxMembers` quota. */
  countMembers(organizationId: string): Promise<number>;
  actingAs(): Promise<ActingAs>;
  /** Throws when the deployment cannot authenticate anyone. Called once, at boot. */
  assertConfigured?(): void;
};
