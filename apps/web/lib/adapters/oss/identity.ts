import type { IdentityPort } from "@/lib/contracts/identity";

export const ossIdentity: IdentityPort = {
  async resolvePrincipal() {
    return { id: "local-operator", label: "Local operator" };
  },
};
