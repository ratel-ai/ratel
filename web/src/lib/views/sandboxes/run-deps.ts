import { getConfig } from "@/config";
import { getDb } from "@/lib/platform/db/client";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { usageLimits } from "@/lib/platform/usage-limits";
import { createDrizzleRunStore } from "./adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "./adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import { sandboxProvider } from "./adapters/provider-from-env";
import type { RunDeps } from "./runs";

/** Runs over the real database, provider and limits. */
export function runDeps(): RunDeps {
  const db = getDb();
  return {
    runs: createDrizzleRunStore(db),
    versions: createDrizzleVersionStore(db),
    secrets: createDrizzleSecretStore(db),
    provider: sandboxProvider(),
    limits: usageLimits(),
    sealingKey: () => sealedSecretsKey(),
    callbackUrl: () => getConfig().sandboxes.callbackUrl ?? publicBaseUrl(),
    now: () => new Date(),
  };
}
