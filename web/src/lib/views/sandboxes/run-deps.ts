import { getConfig } from "@/config";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { usageLimits } from "@/lib/platform/usage-limits";
import { createDrizzleRunStore } from "./adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "./adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import { createDrizzleVmStore } from "./adapters/drizzle-vm-store";
import { sandboxProvider } from "./adapters/provider-from-env";
import type { RunDeps } from "./runs";

const logger = getLogger("sandboxes/run-deps");

/**
 * Runs over the real database, provider and limits. The long part of a run is a task of this
 * process; a route passes Next's `after`, so the task outlives the response. The job queue does not
 * fit: it keeps one queued job of a kind for each project, and runs one job of a project at a time.
 */
export function runDeps(
  background: RunDeps["background"] = (work) => {
    work().catch((error: unknown) => logger.error({ err: error }, "sandbox run task failed"));
  },
): RunDeps {
  const db = getDb();
  return {
    runs: createDrizzleRunStore(db),
    vms: createDrizzleVmStore(db),
    versions: createDrizzleVersionStore(db),
    secrets: createDrizzleSecretStore(db),
    provider: sandboxProvider(),
    limits: usageLimits(),
    sealingKey: () => sealedSecretsKey(),
    callbackUrl: () => getConfig().sandboxes.callbackUrl ?? publicBaseUrl(),
    now: () => new Date(),
    background,
  };
}
