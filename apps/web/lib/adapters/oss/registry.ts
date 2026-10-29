import type { RegistryPort } from "@/lib/contracts/registry";

/** The open-source edition contributes nothing beyond the core modules' own `register.ts` files. */
export const ossRegistry: RegistryPort = {
  registrations() {
    return [];
  },
};
