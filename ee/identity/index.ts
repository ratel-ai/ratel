import type { IdentityPort } from "@/lib/contracts/identity";

export const cloudIdentity: IdentityPort = {
  async resolvePrincipal() {
    return {
      id: "cloud-operator",
      label: "fausto@ratel.sh · Acme Inc",
    };
  },
};
