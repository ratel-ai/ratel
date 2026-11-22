import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { createPgSandboxRunStore, type SandboxDb } from "./adapters/pg-store";
import { readProductionConfigHash } from "./adapters/production-config";
import { readRecordedItems } from "./adapters/recorded-items";
import type { SandboxesPageDeps } from "./page";
import { readSessionReplaySource } from "./replay/pg-session-source";
import type { SessionReplayDeps } from "./replay/session-page";

/** A page render waits at most this long for the production hash; past it the pill shows code defaults. */
const PRODUCTION_HASH_TIMEOUT_MS = 3_000;
const logger = getLogger("sandboxes/page");

/** The production wiring of the Sandboxes pages' loaders. */
export const sandboxesPageDeps: SandboxesPageDeps = {
  listRunners: (projectId) =>
    createPgSandboxRunStore(getDb() as unknown as SandboxDb).listRunners(projectId),
  productionConfigHash: async (query) => {
    try {
      return await withStatementTimeout(
        (db) => readProductionConfigHash(db as unknown as SandboxDb, query),
        {
          operation: "sandboxes_production_config_hash",
          timeoutMs: PRODUCTION_HASH_TIMEOUT_MS,
        },
      );
    } catch (err) {
      // The pill falls back to "code defaults"; the rest of the page still works.
      logger.error(
        { err, project_id: query.projectId, sandbox_id: query.sandboxId },
        "sandbox production config read failed",
      );
      return null;
    }
  },
  recordedItems: async (query) => {
    try {
      return await withStatementTimeout(
        (db) => readRecordedItems(db as unknown as SandboxDb, query),
        { operation: "sandboxes_recorded_items" },
      );
    } catch (err) {
      // The page opens without the item; the Recorded items list can still load it.
      logger.error(
        { err, project_id: query.projectId, sandbox_id: query.sandboxId },
        "sandbox recorded item read failed",
      );
      return [];
    }
  },
  now: () => new Date(),
};

/** The production wiring of session replay: the session read with the project's content opt-in. */
export const sessionReplayDeps: SessionReplayDeps = {
  listRunners: sandboxesPageDeps.listRunners,
  sessionSource: ({ projectId, sessionId }) =>
    withStatementTimeout(
      async (db) =>
        readSessionReplaySource(db, {
          projectId,
          sessionId,
          readContent: await contentOptIn(projectId, db),
        }),
      {
        operation: "sandboxes_session_replay_source",
      },
    ),
};
