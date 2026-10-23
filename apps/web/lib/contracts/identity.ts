/**
 * Token verification is deliberately out of scope for this spike and belongs
 * on the real IdentityPort contract.
 */

export type Principal = {
  id: string;
  label: string;
};

export type IdentityPort = {
  resolvePrincipal(): Promise<Principal | null>;
};
