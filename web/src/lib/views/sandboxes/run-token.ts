import { getDb } from "@/lib/platform/db/client";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { createDrizzleRunStore } from "./adapters/drizzle-run-store";
import type { RunStore } from "./ports/run-store";

type FindKey = (hash: string) => Promise<ApiKey | null>;

export type RunTokenDeps = {
  runs: () => Pick<RunStore, "findByTokenHash">;
};

const defaultDeps: RunTokenDeps = {
  runs: () => createDrizzleRunStore(getDb()),
};

/**
 * A key lookup that also knows run tokens. Only trace ingest uses it, so a run token opens no other
 * route. The token reads as a key of the run's project that only sends traces, while the run lives.
 */
export function withRunTokens(findKey: FindKey, deps: RunTokenDeps = defaultDeps): FindKey {
  return async (hash) => {
    const key = await findKey(hash);
    if (key) return key;
    const run = await deps.runs().findByTokenHash(hash);
    if (!run) return null;
    return {
      id: run.id,
      projectId: run.projectId,
      name: null,
      keyHash: hash,
      keyPrefix: "rtl_run",
      createdAt: new Date(0),
      // Not the first use of a key: ingest records that as a step of the project's setup.
      lastUsedAt: new Date(),
      revokedAt: null,
      expiresAt: null,
      scopes: ["ingest:traces"],
      rateLimitPerMinute: null,
    };
  };
}
