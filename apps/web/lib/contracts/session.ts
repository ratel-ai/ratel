/**
 * Who is signed in. The open-source edition answers with one local operator; the Cloud
 * edition resolves a real identity. Organization, role and projects are not part of the
 * port: the core derives them from the principal and its own tables
 * (`lib/platform/session.ts`), so an identity provider never has to know the schema.
 */
export type Principal = {
  /** Stable across requests; the core keys its `users` row on it (`external_id`). */
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

/**
 * An operator acting inside another organization or as another user (Cloud support sessions).
 * `null` for everyone else. The core grants a synthetic membership from it and never logs the
 * session itself.
 */
export type ActingAs = {
  kind: "organization" | "user";
  targetId: string;
  readOnly: boolean;
} | null;

export type SessionPort = {
  resolvePrincipal(): Promise<Principal | null>;
  /** Whether this principal may use the console at all (Cloud: the launch allowlist). */
  accessGranted(principal: Principal): Promise<boolean>;
  actingAs(): Promise<ActingAs>;
};
